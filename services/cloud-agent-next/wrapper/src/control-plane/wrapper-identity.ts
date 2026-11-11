/**
 * Returns the sandbox-transfer base URL for the wrapper process that owns the
 * connection. The launch environment names the launch-time identity, which is
 * reused when the supervisor restarts the wrapper, so every process must
 * rewrite the final path segment to its own identity.
 */
export function transferUrlForWrapperInstance(baseUrl: string, wrapperInstanceId: string): string {
  const url = new URL(baseUrl);
  const segments = url.pathname.split('/');
  while (segments.length > 1 && segments.at(-1) === '') segments.pop();
  if (segments.length < 2) return baseUrl;
  segments[segments.length - 1] = encodeURIComponent(wrapperInstanceId);
  url.pathname = segments.join('/');
  return url.toString();
}
