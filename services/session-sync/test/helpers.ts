import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { SignJWT } from 'jose';

import type { Env } from '../src/env';
import { toHex } from '../src/hex';
import type { BatchRequest, Change, Principal } from '../src/protocol';

export const testEnv = env as Env;

async function secret(): Promise<string> {
  const binding = testEnv.SESSION_SYNC_SECRET;
  const value = typeof binding === 'string' ? binding : await binding.get();
  if (!value) throw new Error('SESSION_SYNC_SECRET is not configured for tests');
  return value;
}

/** Mints a sync grant in the exact format that `authorize` accepts. */
export async function grant(principal: Principal): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ version: 1, tenant: principal.tenant })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('session-sync')
    .setAudience('session-sync')
    .setSubject(principal.userID)
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(new TextEncoder().encode(await secret()));
}

export function personal(userID: string): Principal {
  return { userID, tenant: { type: 'user', id: userID } };
}

export function member(userID: string, organizationID: string): Principal {
  return { userID, tenant: { type: 'organization', id: organizationID } };
}

export function newSessionID(): string {
  return `ses_${crypto.randomUUID().replaceAll('-', '')}`;
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', bytes));
}

export function batch(
  sourceID: string,
  after: number,
  through: number,
  changes: Change[],
  batchID: string = crypto.randomUUID()
): BatchRequest {
  return { version: 1, sourceID, batchID, after, through, changes };
}

export type Client = {
  send(method: string, path: string, init?: RequestInit): Promise<Response>;
  register(id: string, sourceID: string): Promise<Response>;
  state(id: string): Promise<Response>;
  apply(id: string, body: unknown): Promise<Response>;
  entities(id: string, query?: Record<string, string>): Promise<Response>;
  putBlob(id: string, hash: string, bytes: Uint8Array): Promise<Response>;
  getBlob(id: string, hash: string): Promise<Response>;
  remove(id: string): Promise<Response>;
};

/** An HTTP client for one principal that sends every request through the Worker. */
export function client(principal: Principal): Client {
  async function send(method: string, path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${await grant(principal)}`);
    return SELF.fetch(`https://session-sync.test${path}`, { ...init, method, headers });
  }
  const json = (method: string, path: string, body: unknown) =>
    send(method, path, {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
  const session = (id: string) => `/v1/sessions/${encodeURIComponent(id)}`;

  return {
    send,
    register: (id: string, sourceID: string) => json('PUT', session(id), { version: 1, sourceID }),
    state: (id: string) => send('GET', session(id)),
    apply: (id: string, body: unknown) => json('POST', `${session(id)}/batches`, body),
    entities: (id: string, query: Record<string, string> = {}) =>
      send('GET', `${session(id)}/entities?${new URLSearchParams(query).toString()}`),
    putBlob: (id: string, hash: string, bytes: Uint8Array) =>
      send('PUT', `${session(id)}/blobs/${hash}`, { body: bytes }),
    getBlob: (id: string, hash: string) => send('GET', `${session(id)}/blobs/${hash}`),
    remove: (id: string) => send('DELETE', session(id)),
  };
}

export function blobPrefix(principal: Principal, sessionID: string): string {
  const segments = [principal.tenant.type, principal.tenant.id, sessionID].map(encodeURIComponent);
  return `sessions/${segments.join('/')}/blobs/`;
}
