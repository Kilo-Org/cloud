/**
 * Whether a state-changing request came from a page the app itself served.
 *
 * The Origin header carries its own scheme and host, so this compares it to the
 * request's forwarded host rather than a configured URL: the dev server binds
 * 0.0.0.0 and a local browser may use 127.0.0.1, which a configured origin
 * rejects. SameSite cookies already keep a cross-site POST from carrying the
 * pending-link cookie; this keeps the posture uniform across the route family.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
