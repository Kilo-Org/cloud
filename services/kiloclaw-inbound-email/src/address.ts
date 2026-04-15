const INSTANCE_LOCAL_PART = /^ki-([0-9a-f]{32})$/;

export type ResolvedRecipient = {
  instanceId: string;
  recipientKind: 'legacy' | 'alias';
  recipientAlias?: string;
};

function parseRecipientAddress(
  recipient: string,
  expectedDomain: string | undefined
): { localPart: string; domain: string } | null {
  const [localPart, domain, ...extra] = recipient.trim().toLowerCase().split('@');
  if (!localPart || !domain || extra.length > 0) return null;
  if (expectedDomain && domain !== expectedDomain.toLowerCase()) return null;
  return { localPart, domain };
}

function legacyInstanceIdFromLocalPart(localPart: string): string | null {
  const match = INSTANCE_LOCAL_PART.exec(localPart);
  if (!match) return null;

  const value = match[1];
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function normalizeAliasLocalPart(localPart: string): string {
  return localPart.trim().toLowerCase();
}

export function instanceIdFromRecipient(
  recipient: string,
  expectedDomain: string | undefined
): string | null {
  const parsed = parseRecipientAddress(recipient, expectedDomain);
  if (!parsed) return null;
  return legacyInstanceIdFromLocalPart(parsed.localPart);
}

export async function resolveRecipient(
  recipient: string,
  expectedDomain: string | undefined,
  lookupAlias: (alias: string) => Promise<string | null>
): Promise<ResolvedRecipient | null> {
  const parsed = parseRecipientAddress(recipient, expectedDomain);
  if (!parsed) return null;

  const legacyInstanceId = legacyInstanceIdFromLocalPart(parsed.localPart);
  if (legacyInstanceId) {
    return { instanceId: legacyInstanceId, recipientKind: 'legacy' };
  }

  const alias = normalizeAliasLocalPart(parsed.localPart);
  const instanceId = await lookupAlias(alias);
  if (!instanceId) return null;
  return { instanceId, recipientKind: 'alias', recipientAlias: alias };
}

export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength);
}
