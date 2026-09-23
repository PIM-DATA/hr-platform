import type { Prisma } from '@prisma/client';
import type { AuthContext } from '../../modules/auth/auth.types';

export type Tx = Prisma.TransactionClient;
export type Actor = { auth: AuthContext; ipAddress: string | null; userAgent: string | null };

/** Callbacks a business module registers for its (module) key. Run inside the engine's transaction. */
export interface WorkflowHandlers {
  onApproved?: (ctx: WorkflowCallbackContext, tx: Tx) => Promise<void>;
  onRejected?: (ctx: WorkflowCallbackContext, tx: Tx) => Promise<void>;
  /** Runs inside the cancelling business module's transaction (engine.cancel is internal). */
  onCancelled?: (ctx: WorkflowCallbackContext, tx: Tx) => Promise<void>;
  /**
   * A step has just become the CURRENT pending step — at submit for the first live step, and after each approval that
   * advances the instance. Generic on purpose: the engine passes the snapshot approver and knows nothing about the
   * business module (Leave turns this into an APPROVAL_REQUIRED notification). Never fired for WAITING future steps.
   */
  onStepPending?: (ctx: WorkflowStepPendingContext, tx: Tx) => Promise<void>;
}

export interface WorkflowStepPendingContext extends WorkflowCallbackContext {
  step: { id: string; stepOrder: number; name: string; approverUserId: string | null; approverEmployeeId: string | null };
}
export interface WorkflowCallbackContext {
  instanceId: string;
  module: string;
  entityType: string;
  entityId: string;
  requesterEmployeeId: string;
  actor: Actor;
  comment: string | null;
}

export interface SubmitInput {
  definitionCode: string;
  module: string;
  entityType: string;
  entityId: string;
  requesterEmployeeId: string;
}
