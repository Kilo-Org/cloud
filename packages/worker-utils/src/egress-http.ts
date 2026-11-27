const HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Preserve end-to-end headers, including Set-Cookie values, without forwarding transport identity. */
export function cleanEgressHeaders(input: Headers): Headers {
  const headers = new Headers(input);
  const connection = (headers.get('connection') ?? '')
    .split(',')
    .map(name => name.trim().toLowerCase());
  for (const name of [...headers.keys()]) {
    if (
      HOP_HEADERS.has(name) ||
      connection.includes(name) ||
      name.startsWith('x-kilo-egress-') ||
      name.startsWith('vercel-') ||
      name.startsWith('x-vercel-') ||
      name.startsWith('x-forwarded-') ||
      name === 'forwarded'
    )
      headers.delete(name);
  }
  return headers;
}
