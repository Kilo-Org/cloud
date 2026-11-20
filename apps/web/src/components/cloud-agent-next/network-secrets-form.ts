import {
  networkSecretInputSchema,
  type NetworkSecretChange,
  type NetworkSecretPolicy,
} from '@kilocode/worker-utils/network-secrets';

export type NetworkSecretDraft = NetworkSecretPolicy & { key: string; value?: string };

export type NetworkSecretFormState = {
  key: string;
  secret: string;
  domains: string;
  replacing: boolean;
};
export const emptyNetworkSecretForm: NetworkSecretFormState = {
  key: '',
  secret: '',
  domains: '',
  replacing: false,
};
export function hasPendingNetworkSecret(form: NetworkSecretFormState): boolean {
  return Boolean(form.key || form.secret || form.domains || form.replacing);
}

export function buildNetworkSecretChanges(
  saved: readonly NetworkSecretDraft[],
  current: readonly NetworkSecretDraft[]
): NetworkSecretChange[] {
  return [
    ...saved
      .filter(row => !current.some(candidate => candidate.key === row.key))
      .map(row => ({ key: row.key, delete: true as const })),
    ...current.flatMap(row =>
      row.value === undefined ? [] : [networkSecretInputSchema.parse(row)]
    ),
  ];
}

export type NetworkSecretSaveFailure = { key: string; message: string };

/** Applies every change in order and returns the changes that failed, so earlier changes are not hidden. */
export async function saveNetworkSecretChanges(
  changes: readonly NetworkSecretChange[],
  apply: (change: NetworkSecretChange) => Promise<unknown>
): Promise<NetworkSecretSaveFailure[]> {
  const failures: NetworkSecretSaveFailure[] = [];
  for (const change of changes) {
    try {
      await apply(change);
    } catch (error) {
      failures.push({
        key: change.key,
        message: error instanceof Error ? error.message : 'Could not save this network secret.',
      });
    }
  }
  return failures;
}

/** Keeps only the values of failed changes, so a retry sends only what did not land. */
export function draftAfterFailedSave(
  draft: readonly NetworkSecretDraft[],
  failures: readonly NetworkSecretSaveFailure[]
): NetworkSecretDraft[] {
  const failed = new Set(failures.map(failure => failure.key));
  return draft.map(({ value, ...row }) =>
    value !== undefined && failed.has(row.key) ? { ...row, value } : row
  );
}

export function networkSecretSaveFailureMessage(
  failures: readonly NetworkSecretSaveFailure[],
  changeCount: number
): string {
  const keys = [...new Set(failures.map(failure => failure.key))].join(', ');
  const reason = (failures[0]?.message ?? '').replace(/[.!?]?$/, '.');
  const saved = changeCount > failures.length ? ' Your other changes were saved.' : '';
  return `Could not save ${keys}: ${reason}${saved}`;
}
