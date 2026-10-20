import jwt from 'jsonwebtoken';
import { CLOUD_AGENT_NEXT_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
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

  // Decode only to select the endpoint; the backend verifies the bearer and
  // current user/organization authorization for its exact expected audience.
  let claims: ReturnType<typeof jwt.decode>;
  try {
    claims = jwt.decode(token);
  } catch {
    return { success: false, status: 500, message: 'Failed to verify balance' };
  }
  const isControlToken =
    claims !== null && typeof claims === 'object' && claims.aud === CLOUD_AGENT_NEXT_AUDIENCE;
  const balancePath = isControlToken ? '/api/cloud-agent-next/balance' : '/api/profile/balance';

  let response: Response;
  try {
    response = await fetch(`${backendUrl}${balancePath}`, {
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

const TRPC_ENDPOINT = 'trpc';

function trimSlashes(path: string): string {
  const withoutLeading = path.startsWith('/') ? path.slice(1) : path;
  return withoutLeading.endsWith('/') ? withoutLeading.slice(0, -1) : withoutLeading;
}

/**
 * Extracts every procedure name from a tRPC request path.
 *
 * tRPC identifies a batch with `?batch=1`, percent-decodes the path, then
 * splits it on commas. Empty segments stay in place because tRPC pairs each
 * segment with the input at the same index.
 *
 * Returns `null` when the path cannot be decoded, matching the request tRPC
 * itself would reject rather than silently treating it as unbillable.
 */
export function extractProcedureNames(pathname: string, isBatch: boolean): string[] | null {
  const trimmed = trimSlashes(pathname);
  if (trimmed !== TRPC_ENDPOINT && !trimmed.startsWith(`${TRPC_ENDPOINT}/`)) return [];

  const remainder = trimmed.slice(TRPC_ENDPOINT.length);
  const encodedPath = trimSlashes(remainder);
  if (encodedPath === '') return [];

  let path: string;
  try {
    path = decodeURIComponent(encodedPath);
  } catch {
    return null;
  }

  return isBatch ? path.split(',') : [path];
}

export type TrpcCallInput = {
  procedure: string;
  input: unknown;
};

export type TrpcCallsReadResult =
  | { success: true; isBatch: boolean; calls: TrpcCallInput[] }
  | { success: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readRawInputs(
  request: Request,
  url: URL
): Promise<{ success: true; value: unknown } | { success: false }> {
  if (request.method === 'GET') {
    const inputParam = url.searchParams.get('input');
    if (!inputParam) return { success: true, value: undefined };
    try {
      return { success: true, value: JSON.parse(inputParam) };
    } catch {
      return { success: false };
    }
  }

  try {
    const text = await request.clone().text();
    if (text.length === 0) return { success: true, value: undefined };
    return { success: true, value: JSON.parse(text) };
  } catch {
    return { success: false };
  }
}

/**
 * Reads the procedure names and the raw input for each call in a tRPC request.
 *
 * Batch inputs are keyed by call index (`{"0": ..., "1": ...}`). Non-batch
 * requests use the body (or the `input` query parameter for GET) directly.
 * The middleware must inspect the same raw inputs tRPC will hand to each
 * procedure so it can enforce balance per scope instead of once per request.
 */
export async function readTrpcCalls(request: Request, url: URL): Promise<TrpcCallsReadResult> {
  const isBatch = url.searchParams.get('batch') === '1';
  const procedures = extractProcedureNames(url.pathname, isBatch);
  if (procedures === null) {
    return { success: false, message: 'Invalid request path' };
  }

  const rawInputs = await readRawInputs(request, url);
  if (!rawInputs.success) {
    return {
      success: false,
      message: request.method === 'GET' ? 'Invalid request input' : 'Invalid request body',
    };
  }

  if (isBatch && rawInputs.value !== undefined && !isRecord(rawInputs.value)) {
    return { success: false, message: 'Invalid request body' };
  }

  const inputs = isBatch ? (rawInputs.value as Record<string, unknown> | undefined) : undefined;
  return {
    success: true,
    isBatch,
    calls: procedures.map((procedure, index) => ({
      procedure,
      input: isBatch ? inputs?.[String(index)] : rawInputs.value,
    })),
  };
}

export type BalanceRequestScope = {
  orgId?: string;
  sessionId?: string;
};

/**
 * Reads the organization and session identifiers a balance-required procedure
 * will actually use.
 *
 * `start` creates a new scope from `options.kilocodeOrganizationId`; a
 * top-level field is not part of that schema and must not select a different
 * payer. Session procedures take the authorized scope from the session itself
 * after access validation; a caller-supplied organization can only narrow that
 * check.
 */
export function extractBalanceRequestScope(procedure: string, input: unknown): BalanceRequestScope {
  if (!isRecord(input)) return {};

  let orgId: string | undefined;
  if (procedure === 'start') {
    const options = input.options;
    if (isRecord(options) && typeof options.kilocodeOrganizationId === 'string') {
      orgId = options.kilocodeOrganizationId;
    }
  } else if (typeof input.kilocodeOrganizationId === 'string') {
    orgId = input.kilocodeOrganizationId;
  } else {
    const options = input.options;
    if (isRecord(options) && typeof options.kilocodeOrganizationId === 'string') {
      orgId = options.kilocodeOrganizationId;
    }
  }

  const sessionId =
    typeof input.cloudAgentSessionId === 'string' ? input.cloudAgentSessionId : undefined;

  return { orgId, sessionId };
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
    return metadata?.identity.orgId;
  } catch (error) {
    logger
      .withFields({ error: error instanceof Error ? error.message : String(error), sessionId })
      .warn('Failed to fetch session metadata for balance validation');
    return undefined;
  }
}

/**
 * Set of V2 mutation procedure names that require balance validation.
 *
 * Includes both the legacy (`initiateFromKilocodeSessionV2`, `sendMessageV2`)
 * and unified (`start`, `send`) surfaces — all of them result in model usage
 * once the queued message is flushed to the wrapper.
 */
export const BALANCE_REQUIRED_MUTATIONS = new Set([
  'initiateFromKilocodeSessionV2',
  'sendMessageV2',
  'start',
  'send',
]);
