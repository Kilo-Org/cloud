export type ResolvedRecipient = {
  instanceId: string;
  recipientAlias: string;
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

export function normalizeAliasLocalPart(localPart: string): string {
  return localPart.trim().toLowerCase();
}

export async function resolveRecipient(
  recipient: string,
  expectedDomain: string | undefined,
  lookupAlias: (alias: string) => Promise<string | null>
): Promise<ResolvedRecipient | null> {
  const parsed = parseRecipientAddress(recipient, expectedDomain);
  if (!parsed) return null;

  const alias = normalizeAliasLocalPart(parsed.localPart);
  const instanceId = await lookupAlias(alias);
  if (!instanceId) return null;
  return { instanceId, recipientAlias: alias };
}

export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength);
}
