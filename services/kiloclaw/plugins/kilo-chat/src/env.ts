const DEFAULT_CONTROLLER_URL = 'http://127.0.0.1:18789';

export function resolveControllerUrl(): string {
  return process.env.KILOCLAW_CONTROLLER_URL || DEFAULT_CONTROLLER_URL;
}

export function resolveGatewayToken(): string {
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!token) throw new Error('kilo-chat: OPENCLAW_GATEWAY_TOKEN is required');
  return token;
}
