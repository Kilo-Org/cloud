import type { DataExportDetail } from '../data-export-types';

export type RecoveryActionKey = 'redispatch' | 'cancelAndPurge' | 'cancelAndRetry';

export type RecoveryActionState = DataExportDetail['actions'][RecoveryActionKey];

export type RecoveryActionGate = {
  disabled: boolean;
  reason: string | null;
};

/**
 * Client-side eligibility is only a UX hint. The admin procedure revalidates
 * authorization, generation, lease, and export state for every mutation.
 */
export function resolveRecoveryActionGate(action: RecoveryActionState): RecoveryActionGate {
  if (action.eligible) return { disabled: false, reason: null };
  return {
    disabled: true,
    reason: action.disabledReason ?? 'This action is not available for this export right now.',
  };
}

/** Typed confirmation requires exact equality with the full export ID. */
export function recoveryConfirmationMatches(input: string, exportId: string): boolean {
  return input.length > 0 && input === exportId;
}

export type RecoveryToastCopy = {
  kind: 'success' | 'warning';
  title: string;
  description: string;
};

/** Dispatch reaches the worker (`sent`) or waits in the outbox for the reconciler (`pending`). */
export function redispatchToastCopy(result: {
  generation: number;
  dispatch: 'sent' | 'pending';
}): RecoveryToastCopy {
  if (result.dispatch === 'sent') {
    return {
      kind: 'success',
      title: 'Redispatch sent',
      description: `Generation ${result.generation} was sent to the export worker.`,
    };
  }
  return {
    kind: 'warning',
    title: 'Redispatch queued',
    description: `The worker could not be reached. Generation ${result.generation} is in the outbox and will be dispatched automatically.`,
  };
}

export function retryToastCopy(result: {
  replacementExportId: string;
  generation: number;
  dispatch: 'sent' | 'pending';
}): RecoveryToastCopy {
  if (result.dispatch === 'sent') {
    return {
      kind: 'success',
      title: 'Replacement export created',
      description: 'The new export was sent to the export worker.',
    };
  }
  return {
    kind: 'warning',
    title: 'Replacement export created',
    description:
      'The worker could not be reached. The new export is queued in the outbox and will be dispatched automatically.',
  };
}
