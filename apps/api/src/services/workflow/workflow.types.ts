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
