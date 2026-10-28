import { randomBytes } from 'node:crypto';

/**
 * One reachable `kilo serve` and the credential it requires. The URL and its
 * credential travel together, so a caller that can reach the server can also
 * authenticate to it. `authorization` is absent only for a server started
 * without a password (the legacy wrapper).
 */
export type KiloServer = {
  readonly url: string;
  readonly authorization?: string;
};

export type KiloServerCredential = {
  /** Spawn env for `kilo serve`; its own children inherit it too. */
  readonly env: Readonly<Record<string, string>>;
  readonly authorization: string;
};

/**
 * Kilo's instance routes default the username to `kilo`, but its v2 server
 * routes default to `opencode`, so the wrapper always sets it explicitly.
 */
const KILO_SERVER_USERNAME = 'kilo';

/**
 * A fresh Basic credential for one `kilo serve`. A preview reaches loopback
 * ports in the sandbox, so an unauthenticated Kilo API there would let a
 * browser act on Kilo directly and bypass the control plane.
 */
export function createKiloServerCredential(): KiloServerCredential {
  const password = randomBytes(32).toString('base64url');
  return {
    env: { KILO_SERVER_USERNAME, KILO_SERVER_PASSWORD: password },
    authorization: `Basic ${Buffer.from(`${KILO_SERVER_USERNAME}:${password}`).toString('base64')}`,
  };
}

export function kiloServerHeaders(server: KiloServer): Record<string, string> {
  return server.authorization === undefined ? {} : { Authorization: server.authorization };
}

/** SDK client config (v1, v2 or the v2 event client) for this server. */
export function kiloClientConfig(
  server: KiloServer,
  directory?: string
): { baseUrl: string; directory?: string; headers: Record<string, string> } {
  return {
    baseUrl: server.url,
    ...(directory === undefined ? {} : { directory }),
    headers: kiloServerHeaders(server),
  };
}

/** A raw request to this server, resolved against its URL, with its credential. */
export function fetchKiloServer(
  server: KiloServer,
  input: URL | string,
  init: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(kiloServerHeaders(server))) {
    headers.set(name, value);
  }
  return fetch(new URL(input, server.url), { ...init, headers });
}
