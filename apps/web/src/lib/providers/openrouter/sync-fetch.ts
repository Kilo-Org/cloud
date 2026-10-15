export const SYNC_PROVIDERS_FETCH_TIMEOUT_MS = 20_000;

/** A failed catalog request; `reason` omits the request description repeated in `message`. */
export class SyncFetchError extends Error {
  constructor(
    description: string,
    readonly reason: string,
    options?: ErrorOptions
  ) {
    super(`${description} failed: ${reason}`, options);
    this.name = 'SyncFetchError';
  }
}

function describeFetchFailure(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return `timed out after ${SYNC_PROVIDERS_FETCH_TIMEOUT_MS / 1000}s`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fetches and parses a JSON catalog response within one deadline, so a single slow
 * upstream response cannot use up the cron run's time budget. Returns null for a 404
 * when `allowNotFound` is set.
 */
export async function fetchSyncJson(
  description: string,
  url: string,
  init: RequestInit,
  { allowNotFound = false }: { allowNotFound?: boolean } = {}
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(SYNC_PROVIDERS_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new SyncFetchError(description, describeFetchFailure(error), { cause: error });
  }
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok) {
    throw new SyncFetchError(description, `${response.status} ${response.statusText}`.trim());
  }
  try {
    return await response.json();
  } catch (error) {
    throw new SyncFetchError(description, describeFetchFailure(error), { cause: error });
  }
}

export function describeEntryFailure(error: unknown): string {
  if (error instanceof SyncFetchError) return error.reason;
  return error instanceof Error ? error.message : String(error);
}
