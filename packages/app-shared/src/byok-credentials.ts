/**
 * Which providers take a structured credential rather than one API key.
 *
 * The web BYOK form switches to per-field inputs for these ids, and the mobile
 * picker has to agree: it offers a single masked field, so it sends the reader to
 * the web page instead of failing every paste. The ids are the gateway's own
 * provider ids, and both surfaces read this one table so they cannot drift.
 */
export type StructuredCredentialKind = 'azure' | 'bedrock' | 'vertex';

const STRUCTURED_CREDENTIAL_KINDS: Readonly<Record<string, StructuredCredentialKind>> = {
  azure: 'azure',
  bedrock: 'bedrock',
  'bedrock-byok': 'bedrock',
  vertex: 'vertex',
  'vertex-byok': 'vertex',
};

/** The JSON shape a provider's credential takes, or null for a single API key. */
export function getStructuredCredentialKind(providerId: string): StructuredCredentialKind | null {
  return STRUCTURED_CREDENTIAL_KINDS[providerId] ?? null;
}

/** Whether a key for this provider needs the web form's structured fields. */
export function isStructuredCredentialProvider(providerId: string): boolean {
  return getStructuredCredentialKind(providerId) !== null;
}
