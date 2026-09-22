import type {
  ApprovalRequestId,
  CanonicalRequestType,
  ProviderApprovalDecision,
  ProviderSession,
  ProviderSessionStartInput,
} from "@t3tools/contracts";
import type * as Deferred from "effect/Deferred";
import type * as Scope from "effect/Scope";
import type * as Semaphore from "effect/Semaphore";
import type { AmpTurn } from "./AmpEvents.ts";
import type { AmpProcess } from "./AmpProcess.ts";

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly type: CanonicalRequestType;
}

/**
 * A structured question surfaced in T3's UI through the t3-code MCP ask_user
 * tool. `resolution` settles with the recorded answers, or undefined when the
 * user dismissed the question.
 */
export interface PendingUserInput {
  readonly questions: ReadonlyArray<import("@t3tools/contracts").UserInputQuestion>;
  readonly resolution: Deferred.Deferred<Record<string, unknown> | undefined>;
}
export interface AmpSession {
  session: ProviderSession;
  readonly input: ProviderSessionStartInput;
  readonly scope: Scope.Closeable;
  readonly lock: Semaphore.Semaphore;
  readonly turns: Array<AmpTurn>;
  readonly pending: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly approvedTools: Set<string>;
  readonly turnPromptOffsets: Array<number>;
  promptCount: number;
  activity: { readonly kind: "idle" } | { readonly kind: "running"; readonly turn: AmpTurn };
  process:
    | { readonly kind: "offline" }
    | { readonly kind: "online"; readonly runtime: AmpProcess; readonly scope: Scope.Closeable };
  nativeId: string | undefined;
  launch: {
    readonly settingsPath: string;
    readonly mcpPath: string | undefined;
    readonly environment: NodeJS.ProcessEnv;
  };
  features: ReadonlyArray<string>;
}
