import { type AmpSettings, type ModelSelection, TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { getModelSelectionBooleanOptionValue } from "@t3tools/shared/model";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { spawnAndCollect, AUTH_PROBE_TIMEOUT_MS } from "../provider/providerSnapshot.ts";
import { readAmpSettingsFile } from "../provider/AmpSettingsFile.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const TextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
const Output = Schema.Struct({
  type: Schema.String,
  subtype: Schema.optional(Schema.String),
  is_error: Schema.optional(Schema.Boolean),
  result: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  message: Schema.optional(Schema.Struct({ content: Schema.Array(Schema.Unknown) })),
});
const decodeOutput = Schema.decodeUnknownEffect(Schema.fromJsonString(Output));
const isText = Schema.is(TextBlock);
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const isTextGenerationError = Schema.is(TextGenerationError);

export const makeAmpTextGeneration = Effect.fn("makeAmpTextGeneration")(function* (
  settings: AmpSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const runAmpJson = Effect.fn("AmpTextGeneration.runAmpJson")(function* <
    S extends Schema.Top,
  >(input: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const { operation } = input;
    const output = yield* Effect.gen(function* () {
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-amp-text-" });
      const localSettings = yield* readAmpSettingsFile(settings, environment);
      const connectionSettings = {
        "amp.url": localSettings["amp.url"],
        "amp.proxy": localSettings["amp.proxy"],
        "amp.network.timeout": localSettings["amp.network.timeout"],
      };
      const settingsFile = path.join(directory, "settings.json");
      yield* fs.writeFileString(
        settingsFile,
        yield* encodeJson({
          ...connectionSettings,
          "amp.dangerouslyAllowAll": false,
          "amp.tools.disable": ["*"],
          "amp.permissions": [{ tool: "*", action: "reject" }],
          "amp.mcpServers": {},
          "amp.mcpPermissions": [
            { matches: { command: "*" }, action: "reject" },
            { matches: { url: "*" }, action: "reject" },
          ],
          "amp.skills.disableClaudeCodeSkills": true,
          "amp.updates.mode": "disabled",
        }),
      );
      const binary = settings.binaryPath || "amp";
      const env = { ...environment, AMP_SKIP_UPDATE_CHECK: "1" };
      const authCommand = yield* resolveSpawnCommand(
        binary,
        ["usage", "--no-color", "--settings-file", settingsFile],
        { env },
      );
      const auth = yield* spawnAndCollect(
        binary,
        ChildProcess.make(authCommand.command, authCommand.args, {
          cwd: directory,
          env,
          shell: authCommand.shell,
          stdin: "ignore",
        }),
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
      );
      if (Option.isNone(auth))
        return yield* new TextGenerationError({
          operation,
          detail: "Amp authentication check timed out.",
        });
      if (auth.value.code !== 0)
        return yield* new TextGenerationError({
          operation,
          detail:
            "Amp authentication could not be verified. Run amp login on this environment, then try again.",
        });
      const resolved = yield* resolveSpawnCommand(
        binary,
        [
          "--execute",
          "--stream-json",
          "--no-ide",
          "--no-color",
          "--no-notifications",
          "--no-remote-control-terminal",
          "--plugin-ready-timeout",
          "0",
          "--settings-file",
          settingsFile,
          "--mode",
          input.modelSelection.model || "medium",
          ...(getModelSelectionBooleanOptionValue(input.modelSelection, "fastMode")
            ? ["--fast"]
            : []),
          ...(getModelSelectionBooleanOptionValue(input.modelSelection, "proMode")
            ? ["--features", "pro"]
            : []),
        ],
        { env },
      );
      return yield* spawnAndCollect(
        binary,
        ChildProcess.make(resolved.command, resolved.args, {
          cwd: directory,
          env,
          shell: resolved.shell,
          stdin: { stream: Stream.encodeText(Stream.make(input.prompt)) },
        }),
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              detail: "Amp text generation failed to run.",
              cause,
            }),
      ),
      Effect.timeoutOption(180_000),
    );
    if (Option.isNone(output))
      return yield* new TextGenerationError({
        operation,
        detail: "Amp text generation timed out.",
      });
    if (output.value.code !== 0)
      return yield* new TextGenerationError({
        operation,
        detail: "Amp text generation failed. Check Amp authentication and the selected mode.",
      });
    let text = "";
    let completed = false;
    for (const line of output.value.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const message = yield* decodeOutput(line).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Amp returned invalid streaming output.",
              cause,
            }),
        ),
      );
      if (message.type === "assistant" && message.message)
        text = message.message.content
          .filter(isText)
          .map((block) => block.text)
          .join("\n");
      if (message.type === "result") {
        if (message.is_error || message.subtype?.startsWith("error"))
          return yield* new TextGenerationError({
            operation,
            detail:
              message.error?.trim().slice(0, 2_000) || "Amp could not complete text generation.",
          });
        completed = true;
        if (message.result?.trim()) text = message.result;
      }
    }
    if (!completed || !text.trim())
      return yield* new TextGenerationError({
        operation,
        detail: "Amp returned no completed text response.",
      });
    const decodeGenerated = Schema.decodeUnknownEffect(input.outputSchemaJson);
    return yield* decodeJson(extractJsonObject(text)).pipe(
      Effect.flatMap(decodeGenerated),
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Amp returned invalid structured output.",
            cause,
          }),
      ),
    );
  });
  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("AmpTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });

      const generated = yield* runAmpJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("AmpTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });

      const generated = yield* runAmpJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("AmpTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runAmpJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("AmpTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });

      const generated = yield* runAmpJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
      };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
