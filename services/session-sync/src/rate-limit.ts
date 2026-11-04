/** Workers limiters do not expose the remaining window, so wait one full period. */
export async function rateLimit(limiter: RateLimit | undefined, key: string): Promise<Response | undefined> {
  if (limiter && !(await limiter.limit({ key })).success) {
    return Response.json(
      { error: { code: 'rate_limited', message: 'Too many requests; retry later', retryAt: Date.now() + 60_000 } },
      { status: 429, headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' } }
    );
  }
}
