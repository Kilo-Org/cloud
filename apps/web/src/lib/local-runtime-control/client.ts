import 'server-only';

import { SESSION_INGEST_WORKER_URL } from '@/lib/config.server';
import { generateInternalServiceToken, TOKEN_EXPIRY } from '@/lib/tokens';
import {
  localRuntimeListResponseSchema,
  SESSION_INGEST_RUNTIME_CONTROL_AUDIENCE,
  type LocalRuntimeListResponse,
} from '@kilocode/session-ingest-contracts';

const RUNTIME_LIST_TIMEOUT_MS = 5_000;

export class LocalRuntimeControlRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalRuntimeControlRequestError';
  }
}

export type LocalRuntimeList = LocalRuntimeListResponse;

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new LocalRuntimeControlRequestError('Local runtime list response was not valid JSON');
  }
}

export const LocalRuntimeControlClient = {
  /**
   * Fetch the read-only runtime list for the bound user from the
   * session-ingest service. The five-minute, audience-bound internal token
   * proves the caller is acting on behalf of that user; the service mirrors
   * the audience check and resolves the user DO from the signed payload
   * alone.
   *
   * Any network failure, non-2xx response, or shape mismatch throws a
   * `LocalRuntimeControlRequestError`. Failures are NEVER downgraded to an
   * empty list — the caller decides the recovery state from the typed error.
   */
  async list(userId: string): Promise<LocalRuntimeList> {
    if (!SESSION_INGEST_WORKER_URL) {
      throw new LocalRuntimeControlRequestError('Session ingest worker URL is not configured');
    }

    const token = generateInternalServiceToken(userId, {
      expiresIn: TOKEN_EXPIRY.fiveMinutes,
      audience: SESSION_INGEST_RUNTIME_CONTROL_AUDIENCE,
    });

    let response: Response;
    try {
      response = await fetch(
        `${SESSION_INGEST_WORKER_URL}/internal/runtime-control/runtimes`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(RUNTIME_LIST_TIMEOUT_MS),
        }
      );
    } catch {
      throw new LocalRuntimeControlRequestError('Local runtime list request failed');
    }

    if (!response.ok) {
      throw new LocalRuntimeControlRequestError(
        `Local runtime list request failed (${response.status})`
      );
    }

    const parsed = localRuntimeListResponseSchema.safeParse(await readJson(response));
    if (!parsed.success) {
      throw new LocalRuntimeControlRequestError('Local runtime list response was malformed');
    }

    return parsed.data;
  },
};
