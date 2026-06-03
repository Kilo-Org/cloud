import { createHash, createHmac, randomBytes } from 'node:crypto';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hmacValue(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function expiresAtIso(seconds: number, now = new Date()): string {
  return new Date(now.getTime() + seconds * 1000).toISOString();
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function floorToMinuteIso(now = new Date()): string {
  const window = new Date(now);
  window.setSeconds(0, 0);
  return window.toISOString();
}

export function configSecretAad(configId: string, kind: string): string {
  return `mcp-gateway:config:${configId}:secret:${kind}`;
}

export function providerGrantAad(instanceId: string): string {
  return `mcp-gateway:instance:${instanceId}:provider-grant`;
}
