/**
 * Reads the launch proxy for the wrapper's own WebSockets. Bun's `fetch` reads
 * the proxy environment itself, but its WebSocket client needs the option.
 */
export function controlProxyUrl(
  env: Record<string, string | undefined>,
  log: (message: string) => void
): string | undefined {
  const value = env.HTTPS_PROXY || env.https_proxy;
  if (!value) return undefined;
  const parsed = URL.parse(value);
  if (parsed?.protocol === 'http:' || parsed?.protocol === 'https:') return value;
  // The value can contain proxy credentials, so the log line does not include it.
  log('control-plane proxy URL is invalid; WebSockets connect without a proxy');
  return undefined;
}
