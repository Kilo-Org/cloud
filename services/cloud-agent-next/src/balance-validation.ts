/**
 * Result of a balance check — either success or failure with HTTP status.
 * Used when auth has already been validated by middleware and balance is
 * resolved as part of the cloud agent admission check.
 */
export type BalanceOnlyResult =
  | { success: true }
  | { success: false; status: 402 | 500; message: string };

/**
 * Extracts the tRPC procedure name from a URL pathname.
 * @example "/trpc/initiateSessionStream" -> "initiateSessionStream"
 */
export function extractProcedureName(pathname: string): string | null {
  const match = pathname.match(/^\/trpc\/([^?/]+)/);
  return match ? match[1] : null;
}

/**
 * Extracts organization ID from tRPC input in URL query params.
 * For GET requests (subscriptions), input is JSON-encoded in the 'input' query param.
 */
export function extractOrgIdFromUrl(url: URL): string | undefined {
  const inputParam = url.searchParams.get('input');
  if (!inputParam) return undefined;

  try {
    const input: unknown = JSON.parse(inputParam);
    if (input && typeof input === 'object' && 'kilocodeOrganizationId' in input) {
      const value = (input as Record<string, unknown>).kilocodeOrganizationId;
      if (typeof value === 'string') {
        return value;
      }
    }
  } catch (error) {
    throw new Error(
      `Failed to parse tRPC input: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return undefined;
}

/**
 * Set of V2 mutation procedure names that require balance validation.
 *
 * Includes both the legacy (`initiateFromKilocodeSessionV2`, `sendMessageV2`)
 * and unified (`start`, `send`) surfaces — all of them result in model usage
 * once the queued message is flushed to the wrapper.
 */
export const BALANCE_REQUIRED_MUTATIONS = new Set([
  'prepareSession',
  'initiateFromKilocodeSessionV2',
  'sendMessageV2',
  'start',
  'send',
]);
