import * as z from 'zod';
import {
  PRIVILEGED_ACTION_CLASSES,
  PRIVILEGED_TARGET_KINDS,
  STEP_UP_SURFACES,
  type PrivilegedActionClass,
  type PrivilegedTarget,
  type StepUpOperationBinding,
  type StepUpSurface,
} from '@kilocode/web-shared/lib/admin/privileged-access';

/**
 * What an operation proof is bound to: one action class, one exact operation,
 * and the target account where the caller knows it.
 *
 * The guard builds the value from the request it is authorizing and the admin UI
 * echoes the value a refusal carried, so the two sides always agree. The value
 * never leaves the server except back to the client that made the request; only
 * its SHA-256 is stored on the challenge and the proof.
 */

export type { StepUpSurface, StepUpOperationBinding };

export type StepUpOperation = {
  surface: StepUpSurface;
  /** Exact tRPC procedure path or request pathname. */
  route: string;
  /** Lower-cased tRPC operation type or HTTP method. */
  method: string;
  target: PrivilegedTarget;
};

/**
 * The boundary schema for a client-supplied operation binding. A binding names
 * no identity and grants nothing on its own: it only matches a challenge and a
 * proof, both minted behind a passkey assertion. The client never computes a
 * value here; it echoes the descriptor a refusal carried.
 */
export const stepUpOperationSchema = z
  .object({
    actionClass: z.enum(PRIVILEGED_ACTION_CLASSES),
    surface: z.enum(STEP_UP_SURFACES),
    route: z.string().min(1).max(1024),
    method: z.string().min(1).max(16),
    targetKind: z.enum(PRIVILEGED_TARGET_KINDS),
    targetId: z.string().min(1).max(200).nullable(),
  })
  .strict();

/**
 * Canonical text one proof or challenge is bound to. The version prefix lets a
 * later format change stay distinct from values already stored.
 */
export function stepUpBindingValue(
  actionClass: PrivilegedActionClass,
  operation: StepUpOperation
): string {
  return [
    'v1',
    actionClass,
    operation.surface,
    operation.route,
    operation.method.toLowerCase(),
    operation.target.kind,
    operation.target.id ?? '',
  ].join('\n');
}

export function stepUpOperationFromBinding(binding: StepUpOperationBinding): {
  actionClass: PrivilegedActionClass;
  operation: StepUpOperation;
} {
  return {
    actionClass: binding.actionClass,
    operation: {
      surface: binding.surface,
      route: binding.route,
      method: binding.method,
      target: { kind: binding.targetKind, id: binding.targetId },
    },
  };
}

export function stepUpBindingFromOperation(
  actionClass: PrivilegedActionClass,
  operation: StepUpOperation
): StepUpOperationBinding {
  return {
    actionClass,
    surface: operation.surface,
    route: operation.route,
    method: operation.method.toLowerCase(),
    targetKind: operation.target.kind,
    targetId: operation.target.id,
  };
}

export function stepUpBindingsEqual(
  left: StepUpOperationBinding | null | undefined,
  right: StepUpOperationBinding | null | undefined
): boolean {
  if (!left || !right) return false;
  return (
    left.actionClass === right.actionClass &&
    left.surface === right.surface &&
    left.route === right.route &&
    left.method === right.method &&
    left.targetKind === right.targetKind &&
    left.targetId === right.targetId
  );
}
