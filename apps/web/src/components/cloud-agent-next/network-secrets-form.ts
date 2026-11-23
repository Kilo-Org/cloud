import {
  NETWORK_SECRET_LIMITS,
  networkSecretInputSchema,
  type NetworkSecretChange,
  type NetworkSecretInput,
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

export function parseNetworkSecretForm({
  key,
  secret,
  domains,
}: Pick<NetworkSecretFormState, 'key' | 'secret' | 'domains'>): NetworkSecretInput | string {
  const parsed = networkSecretInputSchema.safeParse({
    key,
    value: secret,
    allowedHosts: domains.split(/[\s,]+/).filter(Boolean),
    locations: ['header'],
  });
  return parsed.success
    ? parsed.data
    : (parsed.error.issues[0]?.message ?? 'Check the network secret.');
}

export function networkSecretAddError(
  rows: readonly { key: string; delivery?: 'env' | 'network' }[],
  key: string
): string | null {
  if (rows.some(row => row.key === key)) return 'This variable name already exists.';
  if (rows.filter(row => row.delivery === 'network').length >= NETWORK_SECRET_LIMITS.MAX_SECRETS) {
    return `Maximum ${NETWORK_SECRET_LIMITS.MAX_SECRETS} network secrets allowed.`;
  }
  return null;
}
