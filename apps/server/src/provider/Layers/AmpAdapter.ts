import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  TurnId,
  type AmpSettings,
  type CanonicalRequestType,
  type ProviderApprovalDecision,
  type ThreadId,
} from "@t3tools/contracts";
import { getModelSelectionBooleanOptionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  ampMessageEvents,
  ampToolType,
  ampTurnUsage,
  makeAmpTurn,
  type AmpEvent,
} from "../amp/AmpEvents.ts";
import type { AmpSession } from "../amp/AmpSession.ts";
import { discoverAmpSkills, rewriteAmpSkillMentions } from "../Drivers/AmpSkills.ts";
import { buildAmpPrompt } from "../amp/AmpPrompt.ts";
import { startAmpPermissions } from "../amp/AmpPermissions.ts";
import { readAmpHistory, runAmpReadCommand } from "../amp/AmpHistory.ts";
import { assertAmpSupervision, makeAmpSettings, startAmpProcess } from "../amp/AmpProcess.ts";
import {
  decodeAmpResume,
  encodeAmpInput,
  encodeAmpPermissionInput,
  type AmpMessage,
  type AmpPermissionRequest,
} from "../amp/AmpProtocol.ts";
import { makeEventNdjsonLogger, type EventNdjsonLogger } from "./EventNdjsonLogger.ts";

type AmpAdapterShape = ProviderAdapterShape<ProviderAdapterError>;
const PROVIDER = ProviderDriverKind.make("amp");

export interface AmpAdapterOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly instanceId?: ProviderInstanceId;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly nativeEventLogPath?: string;
}
const requestError = (method: string, cause: unknown) =>
  new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
const permissionType = (tool: string): CanonicalRequestType => {
  const kind = ampToolType(tool);
  return kind === "command_execution"
    ? "exec_command_approval"
    : kind === "file_change"
      ? "file_change_approval"
      : "dynamic_tool_call";
};

export const makeAmpAdapter = Effect.fn("makeAmpAdapter")(function* (
  settings: AmpSettings,
  options: AmpAdapterOptions = {},
) {
  const instanceId = options.instanceId ?? ProviderInstanceId.make("amp");
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const config = yield* ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const events = yield* Queue.unbounded<import("@t3tools/contracts").ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, AmpSession>();
  const logger =
    options.nativeEventLogger ??
    (options.nativeEventLogPath
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
      : undefined);
  const uuid = crypto.randomUUIDv4.pipe(
    Effect.mapError((cause) => requestError("id/create", cause)),
  );
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const emit = Effect.fn("AmpAdapter.emit")(
    function* (ctx: AmpSession, event: AmpEvent) {
      yield* Queue.offer(events, {
        ...event,
        provider: PROVIDER,
        providerInstanceId: instanceId,
        threadId: ctx.session.threadId,
        eventId: EventId.make(yield* uuid),
        createdAt: yield* now,
      });
    },
    Effect.catch((cause) => Effect.logError("Failed to emit Amp event.", { cause })),
  );
  const requireSession = Effect.fn("AmpAdapter.requireSession")(function* (threadId: ThreadId) {
    const ctx = sessions.get(threadId);
    if (!ctx || ctx.session.status === "closed")
      return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
    return ctx;
  });
  const updateCursor = (ctx: AmpSession) => {
    if (ctx.nativeId)
      ctx.session = {
        ...ctx.session,
        resumeCursor: {
          schemaVersion: 1,
          sessionId: ctx.nativeId,
          turnIds: ctx.turns.map((turn) => turn.id),
          turnPromptOffsets: [...ctx.turnPromptOffsets],
          promptCount: ctx.promptCount,
          features: [...ctx.features],
        },
      };
  };
  const checkSupervision = (ctx: AmpSession) =>
    ctx.session.runtimeMode === "full-access"
      ? Effect.void
      : assertAmpSupervision(ctx.session.cwd ?? process.cwd(), ctx.launch.environment).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError((cause) => requestError("permissions/configuration", cause)),
        );
  const settleApprovals = Effect.fn("AmpAdapter.settleApprovals")(function* (ctx: AmpSession) {
    for (const pending of ctx.pending.values()) yield* Deferred.succeed(pending.decision, "cancel");
  });
  const completeTurn = Effect.fn("AmpAdapter.completeTurn")(function* (
    ctx: AmpSession,
    state: "completed" | "failed" | "cancelled",
    errorMessage?: string,
  ) {
    const updatedAt = yield* now;
    if (ctx.activity.kind !== "running") return;
    const turn = ctx.activity.turn;
    const status = state === "failed" ? "error" : "ready";
    const lastError = state === "failed" ? errorMessage || "Amp execution failed." : undefined;
    ctx.activity = { kind: "idle" };
    ctx.session = {
      ...ctx.session,
      status,
      lastError,
      activeTurnId: undefined,
      updatedAt,
    };
    updateCursor(ctx);
    yield* settleApprovals(ctx);
    if (lastError) {
      yield* emit(ctx, {
        type: "runtime.error",
        turnId: turn.id,
        payload: { message: lastError, class: "provider_error" },
      });
    }
    yield* emit(ctx, {
      type: "turn.completed",
      turnId: turn.id,
      payload: { state, tokenUsage: ampTurnUsage(turn), ...(errorMessage ? { errorMessage } : {}) },
    });
    yield* emit(ctx, {
      type: "session.state.changed",
      payload: { state: status, ...(lastError ? { reason: lastError } : {}) },
    });
  });
  const onMessage = Effect.fn("AmpAdapter.onMessage")(function* (
    ctx: AmpSession,
    message: AmpMessage,
  ) {
    if (ctx.session.status === "closed") return;
    yield* logger?.write(message, ctx.session.threadId) ?? Effect.void;
    if (message.session_id && ctx.nativeId !== message.session_id) {
      ctx.nativeId = message.session_id;
      updateCursor(ctx);
      yield* emit(ctx, {
        type: "thread.started",
        payload: { providerThreadId: message.session_id },
      });
    }
    if (ctx.activity.kind === "running") {
      for (const event of ampMessageEvents(message, ctx.activity.turn)) yield* emit(ctx, event);
      if (
        message.type === "assistant" &&
        !message.parent_tool_use_id &&
        ["end_turn", "max_tokens", "stop_sequence"].includes(message.message.stop_reason ?? "")
      ) {
        yield* completeTurn(
          ctx,
          message.message.stop_reason === "max_tokens" ? "failed" : "completed",
          message.message.stop_reason === "max_tokens"
            ? "Amp reached its output token limit."
            : undefined,
        );
      } else if (message.type === "result") {
        yield* completeTurn(
          ctx,
          message.is_error ? "failed" : "completed",
          message.is_error
            ? message.error || message.errors?.join("\n") || "Amp execution failed."
            : undefined,
        );
      } else if (message.type === "system" && message.subtype.startsWith("error")) {
        yield* completeTurn(ctx, "failed", message.error || "Amp reported an error.");
      }
    }
  });
  const stopProcess = Effect.fn("AmpAdapter.stopProcess")(function* (
    ctx: AmpSession,
    graceful = false,
  ) {
    if (ctx.process.kind === "offline") return;
    const process = ctx.process;
    ctx.process = { kind: "offline" };
    yield* graceful ? process.runtime.finish : process.runtime.stop;
    yield* Scope.close(process.scope, Exit.void);
  });
  const launchProcess = Effect.fn("AmpAdapter.launchProcess")(function* (ctx: AmpSession) {
    yield* checkSupervision(ctx);
    const scope = yield* Scope.make();
    let success = false;
    yield* Effect.addFinalizer(() => (success ? Effect.void : Scope.close(scope, Exit.void)));
    const runtime = yield* startAmpProcess({
      binaryPath: settings.binaryPath,
      cwd: ctx.session.cwd ?? process.cwd(),
      ...ctx.launch,
      sessionId: ctx.nativeId,
      mode: ctx.session.model ?? "medium",
      features: ctx.features,
      fullAccess: ctx.session.runtimeMode === "full-access",
      onMessage: (message) =>
        ctx.lock.withPermits(1)(
          Effect.suspend(() =>
            ctx.process.kind === "online" && ctx.process.scope === scope
              ? onMessage(ctx, message)
              : Effect.void,
          ),
        ),
      onExit: (detail) =>
        ctx.lock.withPermits(1)(
          Effect.gen(function* () {
            if (
              ctx.session.status === "closed" ||
              ctx.process.kind !== "online" ||
              ctx.process.scope !== scope
            )
              return;
            yield* completeTurn(ctx, "failed", detail ?? "Amp exited before completing the turn.");
            ctx.session = {
              ...ctx.session,
              status: "error",
              ...(detail ? { lastError: detail } : {}),
            };
            yield* emit(ctx, {
              type: "session.exited",
              payload: {
                reason: detail ?? "Amp exited.",
                recoverable: true,
                exitKind: detail ? "error" : "graceful",
              },
            });
          }),
        ),
    }).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.mapError((cause) => requestError("session/start", cause)),
    );
    ctx.process = { kind: "online", runtime, scope };
    success = true;
  });
  const requestPermission = Effect.fn("AmpAdapter.requestPermission")(function* (
    ctx: AmpSession,
    request: AmpPermissionRequest,
  ) {
    if (ctx.session.status === "closed") return false;
    if (ctx.session.runtimeMode === "full-access" || ctx.approvedTools.has(request.tool))
      return true;
    if (
      ctx.session.runtimeMode === "auto-accept-edits" &&
      ampToolType(request.tool) === "file_change"
    )
      return true;
    const requestId = ApprovalRequestId.make(yield* uuid);
    const decision = yield* Deferred.make<ProviderApprovalDecision>();
    if (ctx.activity.kind !== "running") return false;
    const type = permissionType(request.tool);
    ctx.pending.set(requestId, { decision, type });
    yield* emit(ctx, {
      type: "request.opened",
      requestId: RuntimeRequestId.make(requestId),
      ...(ctx.activity.kind === "running" ? { turnId: ctx.activity.turn.id } : {}),
      payload: {
        requestType: type,
        detail: `${request.tool}\n${encodeAmpPermissionInput(request.input)}`,
        args: { toolName: request.tool, ...request.input },
      },
      raw: { source: "amp.cli", method: "permission/request", payload: request },
    });
    const answer = yield* Deferred.await(decision).pipe(Effect.timeoutOption("10 minutes"));
    const resolved = answer._tag === "Some" ? answer.value : "cancel";
    ctx.pending.delete(requestId);
    if (resolved === "acceptForSession") ctx.approvedTools.add(request.tool);
    yield* emit(ctx, {
      type: "request.resolved",
      requestId: RuntimeRequestId.make(requestId),
      payload: { requestType: type, decision: resolved },
    });
    return resolved === "accept" || resolved === "acceptForSession";
  });
  const startSession: AmpAdapterShape["startSession"] = Effect.fn("AmpAdapter.startSession")(
    function* (input) {
      const existing = sessions.get(input.threadId);
      if (existing && existing.session.status !== "closed") return existing.session;
      const scope = yield* Scope.make();
      let transferred = false;
      yield* Effect.addFinalizer(() => (transferred ? Effect.void : Scope.close(scope, Exit.void)));
      const resume =
        input.resumeCursor === undefined ? undefined : decodeAmpResume(input.resumeCursor);
      if (resume && Exit.isFailure(resume))
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "Invalid Amp resume cursor.",
        });
      const selection =
        input.modelSelection?.instanceId === instanceId ? input.modelSelection : undefined;
      const createdAt = yield* now;
      const ctx: AmpSession = {
        session: {
          provider: PROVIDER,
          providerInstanceId: instanceId,
          threadId: input.threadId,
          status: "connecting",
          runtimeMode: input.runtimeMode,
          cwd: input.cwd ?? process.cwd(),
          model: selection?.model ?? "medium",
          createdAt,
          updatedAt: createdAt,
        },
        input,
        scope,
        lock: yield* Semaphore.make(1),
        pending: new Map(),
        approvedTools: new Set(),
        activity: { kind: "idle" },
        process: { kind: "offline" },
        nativeId: resume && Exit.isSuccess(resume) ? resume.value.sessionId : undefined,
        turns:
          resume && Exit.isSuccess(resume)
            ? resume.value.turnIds.map((id) => makeAmpTurn(TurnId.make(id)))
            : [],
        turnPromptOffsets:
          resume && Exit.isSuccess(resume)
            ? [...(resume.value.turnPromptOffsets ?? resume.value.turnIds.map((_, index) => index))]
            : [],
        promptCount:
          resume && Exit.isSuccess(resume)
            ? (resume.value.promptCount ?? resume.value.turnIds.length)
            : 0,
        launch: { settingsPath: "", mcpPath: undefined, environment: {} },
        features: [
          getModelSelectionBooleanOptionValue(selection, "fastMode") ? "fast" : "",
          getModelSelectionBooleanOptionValue(selection, "proMode") ? "pro" : "",
        ].filter(Boolean),
      };
      if (resume && Exit.isSuccess(resume) && resume.value.features) {
        ctx.features = [...resume.value.features];
      }
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-amp-" }).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.mapError((cause) => requestError("settings/create", cause)),
      );
      const mcp = McpProviderSession.readMcpProviderSession(input.threadId);
      const environment = McpProviderSession.withAgentDeviceEnvironment(
        { ...(options.environment ?? process.env), AMP_SKIP_UPDATE_CHECK: "1" },
        mcp,
      );
      yield* runAmpReadCommand({
        binaryPath: settings.binaryPath,
        cwd: ctx.session.cwd ?? process.cwd(),
        environment,
        args: [
          "usage",
          "--no-color",
          ...(settings.settingsFile.trim()
            ? ["--settings-file", settings.settingsFile.trim()]
            : []),
        ],
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      const permissions = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            startAmpPermissions({
              directory,
              environment,
              onRequest: (request) => Effect.runPromise(requestPermission(ctx, request)),
            }),
          catch: (cause) => requestError("permissions/start", cause),
        }),
        (bridge) => Effect.promise(() => bridge.close()).pipe(Effect.ignore),
      ).pipe(Effect.provideService(Scope.Scope, scope));
      const files = yield* makeAmpSettings({
        settings,
        directory,
        environment,
        permissionDelegate: permissions.delegate,
        mcpSession: mcp,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.mapError((cause) => requestError("settings/create", cause)),
      );
      ctx.launch = { ...files, environment: permissions.environment };
      sessions.set(input.threadId, ctx);
      yield* checkSupervision(ctx).pipe(
        Effect.onError(() =>
          Effect.sync(() => {
            sessions.delete(input.threadId);
          }),
        ),
      );
      ctx.session = { ...ctx.session, status: "ready", updatedAt: yield* now };
      updateCursor(ctx);
      transferred = true;
      yield* emit(ctx, { type: "session.started", payload: { resume: ctx.session.resumeCursor } });
      yield* emit(ctx, { type: "session.state.changed", payload: { state: "ready" } });
      return { ...ctx.session };
    },
    Effect.scoped,
  );
  const sendTurn: AmpAdapterShape["sendTurn"] = Effect.fn("AmpAdapter.sendTurn")(function* (input) {
    const ctx = yield* requireSession(input.threadId);
    const pending = yield* ctx.lock.withPermits(1)(
      Effect.gen(function* () {
        if (ctx.session.status === "closed" || sessions.get(input.threadId) !== ctx) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
        yield* checkSupervision(ctx);
        if (input.interactionMode === "plan")
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Amp has no native plan mode. Use a normal turn to request a plan.",
          });
        const selection =
          input.modelSelection?.instanceId === instanceId ? input.modelSelection : undefined;
        const model = selection?.model ?? ctx.session.model ?? "medium";
        const features = selection
          ? [
              getModelSelectionBooleanOptionValue(selection, "fastMode") ? "fast" : "",
              getModelSelectionBooleanOptionValue(selection, "proMode") ? "pro" : "",
            ].filter(Boolean)
          : ctx.features;
        const changed = model !== ctx.session.model || features.join() !== ctx.features.join();
        if (ctx.nativeId && features.join() !== ctx.features.join()) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue:
              "Amp Fast and Pro are fixed when the native thread starts. Start a new thread to change them.",
          });
        }
        if (changed && ctx.activity.kind === "running")
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Wait for Amp to finish before changing its mode.",
          });
        const prompt = input.input?.includes("$")
          ? rewriteAmpSkillMentions(
              input.input,
              yield* discoverAmpSkills(
                settings,
                options.environment ?? process.env,
                ctx.session.cwd ?? process.cwd(),
              ).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                Effect.mapError((cause) => requestError("skills/discover", cause)),
              ),
            )
          : input.input;
        const content = yield* buildAmpPrompt(
          { ...input, ...(prompt !== undefined ? { input: prompt } : {}) },
          config.attachmentsDir,
        ).pipe(Effect.provideService(FileSystem.FileSystem, fs));
        if (changed || ctx.session.status === "error")
          yield* stopProcess(ctx, ctx.session.status !== "error");
        ctx.session = { ...ctx.session, model };
        ctx.features = features;
        if (ctx.process.kind === "offline") yield* launchProcess(ctx).pipe(Effect.scoped);
        const updatedAt = yield* now;
        const steering = ctx.activity.kind === "running";
        const turn =
          ctx.activity.kind === "running"
            ? ctx.activity.turn
            : makeAmpTurn(TurnId.make(yield* uuid));
        if (!steering) {
          ctx.turns.push(turn);
          ctx.turnPromptOffsets.push(ctx.promptCount);
          ctx.activity = { kind: "running", turn };
          ctx.session = {
            ...ctx.session,
            status: "running",
            activeTurnId: turn.id,
            updatedAt,
          };
          yield* emit(ctx, { type: "turn.started", turnId: turn.id, payload: { model } });
        }
        ctx.promptCount += 1;
        updateCursor(ctx);
        content.push({ type: "text", text: buildRuntimeInstructions({ harness: "Amp" }) });
        if (ctx.process.kind !== "online")
          return yield* requestError("turn/send", "Amp process is unavailable.");
        const runtime = ctx.process.runtime;
        yield* runtime
          .send(encodeAmpInput(content, `${turn.id}:${ctx.promptCount}`, steering))
          .pipe(
            Effect.onError((cause) =>
              completeTurn(ctx, "failed", String(Cause.squash(cause))).pipe(
                Effect.andThen(stopProcess(ctx)),
              ),
            ),
          );
        return { runtime, turnId: turn.id };
      }),
    );
    yield* pending.runtime.ready.pipe(
      Effect.onError((cause) =>
        ctx.lock.withPermits(1)(
          Effect.gen(function* () {
            if (ctx.process.kind !== "online" || ctx.process.runtime !== pending.runtime) return;
            if (ctx.activity.kind === "running" && ctx.activity.turn.id === pending.turnId) {
              yield* completeTurn(ctx, "failed", String(Cause.squash(cause)));
            }
            yield* stopProcess(ctx);
          }),
        ),
      ),
    );
    return {
      threadId: input.threadId,
      turnId: pending.turnId,
      resumeCursor: ctx.session.resumeCursor,
    };
  });
  const stopSessionInternal = Effect.fn("AmpAdapter.stopSessionInternal")(function* (
    ctx: AmpSession,
  ) {
    const graceful = ctx.activity.kind === "idle";
    yield* completeTurn(ctx, "cancelled");
    ctx.session = {
      ...ctx.session,
      status: "closed",
      activeTurnId: undefined,
      updatedAt: yield* now,
    };
    yield* settleApprovals(ctx);
    yield* stopProcess(ctx, graceful);
    yield* Scope.close(ctx.scope, Exit.void);
    yield* emit(ctx, {
      type: "session.exited",
      payload: { reason: "Amp session stopped.", exitKind: "graceful" },
    });
    if (sessions.get(ctx.session.threadId) === ctx) sessions.delete(ctx.session.threadId);
  });
  const stopAll = () =>
    Effect.forEach(sessions.values(), (ctx) => ctx.lock.withPermits(1)(stopSessionInternal(ctx)), {
      discard: true,
    });
  yield* Effect.addFinalizer(() =>
    stopAll().pipe(
      Effect.andThen(Queue.shutdown(events)),
      Effect.andThen(options.nativeEventLogger ? Effect.void : (logger?.close() ?? Effect.void)),
    ),
  );
  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
    startSession,
    sendTurn,
    interruptTurn: Effect.fn("AmpAdapter.interruptTurn")(function* (threadId, turnId) {
      const ctx = yield* requireSession(threadId);
      yield* ctx.lock.withPermits(1)(
        Effect.gen(function* () {
          if (turnId && (ctx.activity.kind !== "running" || ctx.activity.turn.id !== turnId))
            return;
          yield* completeTurn(ctx, "cancelled");
          yield* stopProcess(ctx);
        }),
      );
    }),
    respondToRequest: Effect.fn("AmpAdapter.respondToRequest")(
      function* (threadId, requestId, decision) {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pending.get(requestId);
        if (!pending)
          return yield* requestError(
            "permission/respond",
            `Unknown approval request '${requestId}'.`,
          );
        yield* Deferred.succeed(pending.decision, decision);
      },
    ),
    respondToUserInput: () =>
      Effect.fail(
        requestError(
          "input/respond",
          "Amp asks questions through normal chat messages. Reply with a new message.",
        ),
      ),
    stopSession: Effect.fn("AmpAdapter.stopSession")(function* (threadId) {
      const ctx = yield* requireSession(threadId);
      yield* ctx.lock.withPermits(1)(stopSessionInternal(ctx));
    }),
    listSessions: () =>
      Effect.sync(() =>
        [...sessions.values()]
          .filter((ctx) => ctx.session.status !== "closed")
          .map((ctx) => ({ ...ctx.session })),
      ),
    hasSession: (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && ctx.session.status !== "closed";
      }),
    readThread: Effect.fn("AmpAdapter.readThread")(function* (threadId) {
      const ctx = yield* requireSession(threadId);
      if (
        ctx.nativeId &&
        ctx.turns.some((turn) => turn.items.length === 0) &&
        ctx.activity.kind === "idle"
      ) {
        const turns = yield* readAmpHistory({
          binaryPath: settings.binaryPath,
          cwd: ctx.session.cwd ?? process.cwd(),
          environment: ctx.launch.environment,
          sessionId: ctx.nativeId,
          turnPromptOffsets: ctx.turnPromptOffsets,
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
        for (const [index, turn] of ctx.turns.entries())
          if (turn.items.length === 0) turn.items.push(...(turns[index] ?? []));
      }
      return {
        threadId,
        turns: ctx.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
      };
    }),
    rollbackThread: () =>
      Effect.fail(
        requestError(
          "thread/rollback",
          "Amp does not support rewinding native conversation history.",
        ),
      ),
    stopAll,
    streamEvents: Stream.fromQueue(events),
  } satisfies AmpAdapterShape;
});
