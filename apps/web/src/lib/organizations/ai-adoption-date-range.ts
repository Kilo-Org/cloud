const HOUR_MS = 60 * 60 * 1000;

/**
 * Snaps an AI-adoption date range to UTC hour boundaries: the start down, the end up so the
 * current hour's activity stays inside the range. The dashboard builds its range from `now`, so
 * without this every mount sends a new range, and neither React Query nor the server cache
 * could reuse a result. The router applies the same snap, which also bounds how many distinct
 * cache keys a client can create.
 */
export function roundAIAdoptionDateRange(range: { startDate: string; endDate: string }): {
  startDate: string;
  endDate: string;
} {
  const start = new Date(range.startDate).getTime();
  const end = new Date(range.endDate).getTime();
  return {
    startDate: new Date(Math.floor(start / HOUR_MS) * HOUR_MS).toISOString(),
    endDate: new Date(Math.ceil(end / HOUR_MS) * HOUR_MS).toISOString(),
  };
}
