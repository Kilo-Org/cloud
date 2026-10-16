/**
 * Copies a request so the copy aborts when the original request's caller goes away.
 * A Durable Object request keeps running after its caller is canceled, and the runtime
 * does not pass an incoming request's own signal through to a subrequest (even when it
 * is passed explicitly), so the abort is relayed through a new controller. Needs the
 * `enable_request_signal` compatibility flag for the original signal to fire.
 */
export function withCallerCancellation(request: Request): Request {
  const callerGone = new AbortController();
  request.signal.addEventListener('abort', () => callerGone.abort(request.signal.reason), {
    once: true,
  });
  return new Request(request, { signal: callerGone.signal });
}
