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
export interface AmpSession {
  session: ProviderSession;
  readonly input: ProviderSessionStartInput;
  readonly scope: Scope.Closeable;
  readonly lock: Semaphore.Semaphore;
  readonly turns: Array<AmpTurn>;
  readonly pending: Map<ApprovalRequestId, PendingApproval>;
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
