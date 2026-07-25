export type LatestOnlyRefreshResult<TValue> =
  | { status: 'applied'; value: TValue }
  | { error: unknown; status: 'failed' }
  | { status: 'stale' };

export interface LatestOnlyRefresh {
  /**
   * Runs `work` under a monotonic generation token. Resolves a discriminated
   * result: `'applied'` when this invocation is still latest and succeeded,
   * `'failed'` when still latest and rejected, or `'stale'` when a newer
   * generation has already begun (success and failure alike are discarded).
   */
  run: <TValue>(work: () => Promise<TValue>) => Promise<LatestOnlyRefreshResult<TValue>>;
  /** True when `token` is still the most recent generation. */
  isLatest: (token: number) => boolean;
  /** Begins a generation and returns its token without running work. */
  begin: () => number;
}

export const createLatestOnlyRefresh = (): LatestOnlyRefresh => {
  let latestToken = 0;

  const begin = (): number => {
    latestToken += 1;
    return latestToken;
  };

  const isLatest = (token: number): boolean => token === latestToken;

  const run = async <TValue>(
    work: () => Promise<TValue>
  ): Promise<LatestOnlyRefreshResult<TValue>> => {
    const token = begin();
    try {
      const value = await work();
      return isLatest(token) ? { status: 'applied', value } : { status: 'stale' };
    } catch (error) {
      return isLatest(token) ? { error, status: 'failed' } : { status: 'stale' };
    }
  };

  return { begin, isLatest, run };
};
