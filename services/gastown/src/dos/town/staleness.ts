export const HEARTBEAT_STALE_MS = 90_000;

export function staleMs(timestamp: string | null, thresholdMs: number): boolean {
  if (!timestamp) return true;
  return Date.now() - new Date(timestamp).getTime() > thresholdMs;
}

export function heartbeatStale(timestamp: string | null): boolean {
  return staleMs(timestamp, HEARTBEAT_STALE_MS);
}
