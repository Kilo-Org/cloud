const INSTANCE_LOCAL_PART = /^ki-([0-9a-f]{32})$/;

export function instanceIdFromRecipient(
  recipient: string,
  expectedDomain: string | undefined
): string | null {
  const [localPart, domain, ...extra] = recipient.trim().toLowerCase().split('@');
  if (!localPart || !domain || extra.length > 0) return null;
  if (expectedDomain && domain !== expectedDomain.toLowerCase()) return null;

  const match = INSTANCE_LOCAL_PART.exec(localPart);
  if (!match) return null;

  const value = match[1];
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength);
}
