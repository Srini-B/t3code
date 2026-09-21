import type { AmpSettings } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ProviderAdapterRequestError } from "../Errors.ts";
import type { McpProviderSessionConfig } from "../../mcp/McpProviderSession.ts";
import { decodeAmpMessage, type AmpMessage } from "./AmpProtocol.ts";
import { runAmpReadCommand } from "./AmpHistory.ts";

const decodeSettings = Schema.decodeUnknownEffect(
  fromLenientJson(Schema.Record(Schema.String, Schema.Unknown)),
);
const encodeSettings = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const mapError = (method: string, cause: unknown) =>
  new ProviderAdapterRequestError({
    provider: "amp",
    method,
    detail: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

export const assertAmpSupervision = Effect.fn("assertAmpSupervision")(function* (
  cwd: string,
  environment: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const checkFile = Effect.fn("assertAmpSupervision.checkFile")(function* (file: string) {
    const settings = yield* fs.readFileString(file).pipe(Effect.flatMap(decodeSettings));
    const permissions = settings["amp.permissions"];
    if (
      settings["amp.dangerouslyAllowAll"] === true ||
      (permissions !== undefined && (!Array.isArray(permissions) || permissions.length > 0))
    ) {
      return yield* mapError(
        "permissions/configuration",
        `Amp supervision is overridden by ${file}. Remove its amp.permissions and amp.dangerouslyAllowAll overrides or select Full access.`,
      );
    }
  });
  const boundary = yield* runAmpReadCommand({
    binaryPath: "git",
    cwd,
    environment,
    args: ["rev-parse", "--show-toplevel"],
  }).pipe(
    Effect.map((root) => path.resolve(root.trim() || cwd)),
    Effect.orElseSucceed(() => path.resolve(cwd)),
  );
  let directory = path.resolve(cwd);
  for (;;) {
    const json = path.join(directory, ".amp", "settings.json");
    const jsonc = path.join(directory, ".amp", "settings.jsonc");
    const settingsFile = (yield* fs.exists(json))
      ? json
      : (yield* fs.exists(jsonc))
        ? jsonc
        : undefined;
    if (settingsFile) {
      yield* checkFile(settingsFile);
      break;
    }
    const parent = path.dirname(directory);
    const reachedBoundary =
      platform === "win32"
        ? directory.toLowerCase() === boundary.toLowerCase()
        : directory === boundary;
    if (reachedBoundary || parent === directory) break;
    directory = parent;
  }
  const managedRoot =
    platform === "darwin"
      ? "/Library/Application Support/ampcode"
      : platform === "win32"
        ? path.join(environment.ProgramData ?? "C:\\ProgramData", "ampcode")
        : "/etc/ampcode";
  const managed = path.join(managedRoot, "managed-settings.json");
  if (yield* fs.exists(managed)) yield* checkFile(managed);
});

export const makeAmpSettings = Effect.fn("makeAmpSettings")(function* (input: {
  readonly settings: AmpSettings;
  readonly directory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly permissionDelegate: string;
  readonly mcpSession: McpProviderSessionConfig | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = input.environment.HOME ?? input.environment.USERPROFILE;
  let source =
    input.settings.settingsFile.trim() ||
    input.environment.AMP_SETTINGS_FILE ||
    (home
      ? path.join(
          input.environment.XDG_CONFIG_HOME || path.join(home, ".config"),
          "amp",
          "settings.json",
        )
      : undefined);
  const explicit = Boolean(
    input.settings.settingsFile.trim() || input.environment.AMP_SETTINGS_FILE,
  );
  if (!explicit && source && !(yield* fs.exists(source))) {
    const alternate = source.replace(/\.json$/, ".jsonc");
    if (yield* fs.exists(alternate)) source = alternate;
  }
  const settings =
    source && (explicit || (yield* fs.exists(source)))
      ? yield* fs.readFileString(source).pipe(Effect.flatMap(decodeSettings))
      : {};
  const settingsPath = path.join(input.directory, "settings.json");
  yield* fs.writeFileString(
    settingsPath,
    encodeSettings({
      ...settings,
      "amp.dangerouslyAllowAll": false,
      "amp.permissions": [{ tool: "*", action: "delegate", to: input.permissionDelegate }],
      "amp.updates.mode": "disabled",
      "amp.remoteThreadCreation.enabled": false,
      "amp.notifications.enabled": false,
    }),
    { mode: 0o600 },
  );
  const mcpPath = path.join(input.directory, "mcp.json");
  if (input.mcpSession) {
    yield* fs.writeFileString(
      mcpPath,
      encodeSettings({
        "t3-code": {
          url: input.mcpSession.endpoint,
          headers: { Authorization: input.mcpSession.authorizationHeader },
        },
      }),
      { mode: 0o600 },
    );
  }
  return { settingsPath, mcpPath: input.mcpSession ? mcpPath : undefined };
});

export const startAmpProcess = Effect.fn("startAmpProcess")(function* (input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly settingsPath: string;
  readonly mcpPath: string | undefined;
  readonly sessionId: string | undefined;
  readonly mode: string;
  readonly features: ReadonlyArray<string>;
  readonly fullAccess: boolean;
  readonly onMessage: (message: AmpMessage) => Effect.Effect<void>;
  readonly onExit: (detail: string | undefined) => Effect.Effect<void>;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.Scope;
  const prompts = yield* Queue.unbounded<string, Cause.Done>();
  const ready = yield* Deferred.make<void, ProviderAdapterRequestError>();
  const outputDone = yield* Deferred.make<void>();
  let stderr = "";
  let intentionalStop = false;
  let exitHandled = false;
  const notifyExit = (detail: string | undefined) =>
    Effect.suspend(() => {
      if (intentionalStop || exitHandled) return Effect.void;
      exitHandled = true;
      return input.onExit(detail);
    });
  const args = [
    ...(input.sessionId ? ["threads", "continue", input.sessionId] : []),
    "--execute",
    "--stream-json-thinking",
    "--stream-json-input",
    "--no-archive-after-execute",
    "--no-ide",
    "--no-notifications",
    "--no-color",
    "--no-remote-control-terminal",
    ...(!input.sessionId ? ["--executor", "local"] : []),
    "--mode",
    input.mode,
    "--settings-file",
    input.settingsPath,
    ...input.features.flatMap((feature) => ["--features", feature]),
    ...(input.fullAccess ? ["--dangerously-allow-all"] : []),
    ...(input.mcpPath ? ["--mcp-config", input.mcpPath] : []),
  ];
  const resolved = yield* resolveSpawnCommand(input.binaryPath || "amp", args, {
    env: input.environment,
  });
  const child = yield* spawner
    .spawn(
      ChildProcess.make(resolved.command, resolved.args, {
        cwd: input.cwd,
        env: input.environment,
        shell: resolved.shell,
        stdin: { stream: Stream.encodeText(Stream.fromQueue(prompts)) },
      }),
    )
    .pipe(Effect.mapError((cause) => mapError("process/start", cause)));
  yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((text) =>
      Effect.sync(() => {
        stderr = (stderr + text).slice(-16_384);
      }),
    ),
    Effect.ignore,
    Effect.forkIn(scope),
  );
  yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.trim().length > 0),
    Stream.runForEach((line) =>
      decodeAmpMessage(line).pipe(
        Effect.mapError((cause) => mapError("stream/decode", cause)),
        Effect.flatMap((message) =>
          input
            .onMessage(message)
            .pipe(
              Effect.andThen(
                message.type === "system" && message.subtype === "init"
                  ? Deferred.succeed(ready, undefined)
                  : Effect.void,
              ),
            ),
        ),
      ),
    ),
    Effect.catch((cause) =>
      Effect.gen(function* () {
        yield* Deferred.fail(ready, mapError("stream/read", cause));
        yield* notifyExit(cause.message);
        yield* child.kill({ forceKillAfter: "2 seconds" }).pipe(Effect.ignore);
      }),
    ),
    Effect.ensuring(Deferred.succeed(outputDone, undefined)),
    Effect.forkIn(scope),
  );
  yield* child.exitCode.pipe(
    Effect.flatMap((code) =>
      Effect.gen(function* () {
        yield* Deferred.await(outputDone);
        const detail =
          Number(code) === 0 ? undefined : stderr.trim() || `Amp exited with code ${Number(code)}.`;
        yield* Deferred.fail(
          ready,
          mapError("process/start", detail ?? "Amp exited before initialization."),
        );
        yield* notifyExit(detail);
      }),
    ),
    Effect.catch((cause) => notifyExit(String(cause))),
    Effect.forkIn(scope),
  );
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      intentionalStop = true;
    }).pipe(
      Effect.andThen(
        Deferred.fail(
          ready,
          mapError("process/start", "Amp session stopped before initialization."),
        ),
      ),
      Effect.andThen(Queue.shutdown(prompts)),
    ),
  );
  return {
    ready: Deferred.await(ready).pipe(
      Effect.timeout("30 seconds"),
      Effect.mapError((cause) => mapError("session/start", cause)),
    ),
    send: (message: string) =>
      Queue.offer(prompts, message).pipe(
        Effect.flatMap((accepted) =>
          accepted ? Effect.void : Effect.fail(mapError("turn/send", "Amp stdin is closed.")),
        ),
      ),
    finish: Effect.sync(() => {
      intentionalStop = true;
    }).pipe(
      Effect.andThen(Queue.end(prompts)),
      Effect.andThen(child.exitCode),
      Effect.timeout("10 seconds"),
      Effect.catch(() => child.kill({ forceKillAfter: "2 seconds" })),
      Effect.asVoid,
      Effect.ignore,
    ),
    stop: Effect.sync(() => {
      intentionalStop = true;
    }).pipe(
      Effect.andThen(
        Deferred.fail(
          ready,
          mapError("process/start", "Amp session stopped before initialization."),
        ),
      ),
      Effect.andThen(child.kill({ forceKillAfter: "2 seconds" })),
      Effect.ignore,
    ),
  };
});
export type AmpProcess = Effect.Success<ReturnType<typeof startAmpProcess>>;
