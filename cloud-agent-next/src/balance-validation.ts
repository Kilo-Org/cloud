import { DEFAULT_BACKEND_URL } from './constants.js';
import { logger } from './logger.js';
import type { Env } from './types.js';
import type { PersistenceEnv } from './persistence/types.js';
import { fetchSessionMetadata } from './session-service.js';

const MIN_BALANCE_DOLLARS = 1;

/**
 * Result of balance validation - either success or failure with HTTP status.
 * Used when auth has already been validated by middleware.
 */
export type BalanceOnlyResult =
  | { success: true }
  | { success: false; status: 402 | 500; message: string };

/**
 * Validates balance only, skipping JWT validation.
 * Use this when auth has already been validated by middleware.
 *
 * @param token - The already-validated JWT token
 * @param orgId - Optional organization ID for org-specific balance check
 * @param env - Worker environment with secrets and bindings
 */
export async function validateBalanceOnly(
  token: string,
  orgId: string | undefined,
  env: Env
): Promise<BalanceOnlyResult> {
  const backendUrl = env.KILOCODE_BACKEND_BASE_URL || DEFAULT_BACKEND_URL;

  const headers = new Headers({
    Authorization: `Bearer ${token}`,
  });
  if (orgId) {
    headers.set('X-KiloCode-OrganizationId', orgId);
  }

  let response: Response;
  try {
    response = await fetch(`${backendUrl}/api/profile/balance`, {
      method: 'GET',
      headers,
    });
  } catch (error) {
    logger
      .withFields({ error: error instanceof Error ? error.message : String(error) })
      .error('Failed to fetch balance');
    return { success: false, status: 500, message: 'Failed to verify balance' };
  }

  if (!response.ok) {
    logger
      .withFields({ status: response.status, statusText: response.statusText })
      .error('Balance API returned error');
    return { success: false, status: 500, message: 'Failed to verify balance' };
  }

  let data: { balance: number; isDepleted: boolean };
  try {
    data = await response.json();
  } catch {
    return { success: false, status: 500, message: 'Invalid balance response' };
  }

  if (data.isDepleted || typeof data.balance !== 'number' || data.balance < MIN_BALANCE_DOLLARS) {
    return { success: false, status: 402, message: 'Insufficient credits: $1 minimum required' };
  }

  return { success: true };
}

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
    const input = JSON.parse(inputParam);
    if (input && typeof input === 'object' && 'kilocodeOrganizationId' in input) {
      const value = input.kilocodeOrganizationId;
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
 * Fetches the orgId for a session from the Durable Object metadata.
 * Used by sendMessageV2 to get the org context for balance validation.
 *
 * @param env - Worker environment with DO bindings
 * @param userId - User ID from auth
 * @param sessionId - Session ID from URL input
 * @returns The orgId if found, undefined otherwise
 */
export async function fetchOrgIdForSession(
  env: PersistenceEnv,
  userId: string,
  sessionId: string
): Promise<string | undefined> {
  try {
    const metadata = await fetchSessionMetadata(env, userId, sessionId);
    return metadata?.orgId;
  } catch (error) {
    logger
      .withFields({ error: error instanceof Error ? error.message : String(error), sessionId })
      .warn('Failed to fetch session metadata for balance validation');
    return undefined;
  }
}

/**
 * Set of V2 mutation procedure names that require balance validation
 */
export const BALANCE_REQUIRED_MUTATIONS = new Set([
  'initiateFromKilocodeSessionV2',
  'sendMessageV2',
]);
