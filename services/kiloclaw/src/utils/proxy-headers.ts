import { deriveGatewayToken } from '../auth/gateway-token';

export async function buildForwardHeaders(params: {
  requestHeaders: Headers;
  machineId: string;
  sandboxId: string;
  gatewayTokenSecret: string;
}): Promise<Headers> {
  const { requestHeaders, machineId, sandboxId, gatewayTokenSecret } = params;
  const forwardHeaders = new Headers(requestHeaders);

  const gatewayToken = await deriveGatewayToken(sandboxId, gatewayTokenSecret);
  forwardHeaders.set('x-kiloclaw-proxy-token', gatewayToken);
  forwardHeaders.set('fly-force-instance-id', machineId);
  forwardHeaders.delete('host');

  return forwardHeaders;
}
