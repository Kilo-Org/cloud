/**
 * Gastown is killed only when GASTOWN_KILLED is exactly `true`. While killed,
 * the worker answers every request with 503, Durable Object alarms stop
 * re-arming, and containers cannot start.
 */
export function isGastownKilled(env: Pick<Env, 'GASTOWN_KILLED'>): boolean {
  return env.GASTOWN_KILLED === 'true';
}

export function gastownKilledResponse(): Response {
  return new Response(JSON.stringify({ success: false, error: 'Gastown is disabled' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
