import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { ProviderAdapterRequestError } from "../Errors.ts";
import { collectStreamAsString } from "../providerSnapshot.ts";

const NativeMessage = Schema.Struct({
  role: Schema.String,
  content: Schema.Array(
    Schema.StructWithRest(Schema.Struct({ type: Schema.String }), [
      Schema.Record(Schema.String, Schema.Unknown),
    ]),
  ),
  messageId: Schema.optionalKey(Schema.Finite),
  protocolMessageID: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(
    Schema.Struct({ type: Schema.String, stopReason: Schema.optionalKey(Schema.String) }),
  ),
});
const NativeThread = Schema.Struct({ id: Schema.String, messages: Schema.Array(NativeMessage) });
const decodeThread = Schema.decodeUnknownEffect(Schema.fromJsonString(NativeThread));
const isAdapterRequestError = Schema.is(ProviderAdapterRequestError);

export const runAmpReadCommand = Effect.fn("runAmpReadCommand")(
  function* (input: {
    readonly binaryPath: string;
    readonly cwd: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly args: ReadonlyArray<string>;
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const resolved = yield* resolveSpawnCommand(input.binaryPath || "amp", input.args, {
      env: input.environment,
    });
    const child = yield* spawner.spawn(
      ChildProcess.make(resolved.command, resolved.args, {
        cwd: input.cwd,
        env: input.environment,
        shell: resolved.shell,
        stdin: "ignore",
      }),
    );
    const [stdout, stderr, code] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout, { maxBytes: 32 * 1024 * 1024 }),
        collectStreamAsString(child.stderr, { maxBytes: 16 * 1024 }),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (Number(code) !== 0)
      return yield* new ProviderAdapterRequestError({
        provider: "amp",
        method: input.args[0] ?? "command",
        detail:
          stderr.trim() ||
          (input.args[0] === "usage"
            ? "Amp is not authenticated. Run amp login on this environment."
            : "Amp could not read the native thread."),
      });
    return stdout;
  },
  Effect.timeout("30 seconds"),
  Effect.scoped,
  Effect.mapError((cause) =>
    isAdapterRequestError(cause)
      ? cause
      : new ProviderAdapterRequestError({
          provider: "amp",
          method: "command/read",
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
  ),
);

export const readAmpHistory = Effect.fn("readAmpHistory")(function* (input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly sessionId: string;
  readonly turnPromptOffsets: ReadonlyArray<number>;
}) {
  const raw = yield* runAmpReadCommand({
    ...input,
    args: ["threads", "export", input.sessionId, "--no-color"],
  });
  const thread = yield* decodeThread(raw).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: "amp",
          method: "thread/export",
          detail: "Amp returned an invalid native thread export.",
          cause,
        }),
    ),
  );
  if (thread.id !== input.sessionId)
    return yield* new ProviderAdapterRequestError({
      provider: "amp",
      method: "thread/export",
      detail: "Amp returned a different native thread.",
    });
  const userMessageIndexes = thread.messages.flatMap((message, index) =>
    message.role === "user" &&
    message.content.some((block) => block.type === "text" || block.type === "image")
      ? [index]
      : [],
  );
  return input.turnPromptOffsets.map((offset, index) => {
    const start = userMessageIndexes[offset];
    const next = input.turnPromptOffsets[index + 1];
    const end = next === undefined ? undefined : userMessageIndexes[next];
    return start === undefined ? [] : thread.messages.slice(start, end);
  });
});
