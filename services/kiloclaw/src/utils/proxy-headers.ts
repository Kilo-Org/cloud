import { deriveGatewayToken } from '../auth/gateway-token';

export async function buildForwardHeaders(params: {
  requestHeaders: Headers;
  sandboxId: string;
  gatewayTokenSecret: string;
  providerHeaders?: Record<string, string>;
}): Promise<Headers> {
  const { requestHeaders, sandboxId, gatewayTokenSecret, providerHeaders } = params;
  const forwardHeaders = new Headers(requestHeaders);

  const gatewayToken = await deriveGatewayToken(sandboxId, gatewayTokenSecret);
  forwardHeaders.set('x-kiloclaw-proxy-token', gatewayToken);
  for (const [name, value] of Object.entries(providerHeaders ?? {})) {
    forwardHeaders.set(name, value);
  }
  forwardHeaders.delete('host');

  return forwardHeaders;
}
