import type { EnvironmentId, ThreadId, UserInputQuestion } from "@t3tools/contracts";

/**
 * The adapter-installed half of the bridge: opening a question emits T3's
 * `user-input.requested` flow and settles when the user answers. Resolving
 * with `undefined` means the user dismissed the question.
 */
export interface AmpUserInputBridge {
  readonly openQuestion: (
    questions: ReadonlyArray<UserInputQuestion>,
  ) => Promise<Record<string, unknown> | undefined>;
}

const bridges = new Map<
  ThreadId,
  { readonly environmentId: EnvironmentId | undefined; readonly bridge: AmpUserInputBridge }
>();

export function setAmpUserInputBridge(config: {
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId | undefined;
  readonly bridge: AmpUserInputBridge;
}): void {
  bridges.set(config.threadId, {
    environmentId: config.environmentId,
    bridge: config.bridge,
  });
}

export function clearAmpUserInputBridge(threadId: ThreadId): void {
  bridges.delete(threadId);
}

export function clearAllAmpUserInputBridges(): void {
  bridges.clear();
}

/**
 * The live bridge for an MCP invocation, or undefined when the thread is not
 * running an Amp session with the bridge installed. Checked by the ask_user
 * handler so other providers' MCP credentials cannot open question rows.
 */
export function readAmpUserInputBridge(
  threadId: ThreadId,
  environmentId: EnvironmentId | undefined,
): AmpUserInputBridge | undefined {
  const entry = bridges.get(threadId);
  return entry !== undefined && entry.environmentId === environmentId ? entry.bridge : undefined;
}
