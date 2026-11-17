/* eslint-disable eslint/id-length, typescript-eslint/consistent-type-definitions -- fragment keys `t` and `v` are wire names; AGENTS.md prefers type over interface */
import { z } from 'zod';
import { decodePairingKey, decodePairingNonce } from './encoding';

/*
 * Loopback pairing boundary (SPEC "Loopback pairing"). The CLI opens
 * `http://127.0.0.1:<port>/__kilo_browser_pair#v=1&hub=<hubId>&t=<token>&ws=<ws url>`;
 * the extension reads the fragment, closes the tab, and redeems the single-use
 * token for the 32-byte key. Only loopback socket URLs are ever accepted.
 */

export const PAIRING_PATH = '/__kilo_browser_pair';
export const PAIRING_KEY_PATH = '/__kilo_browser_pair/key';
export const HUB_WS_PATH = '/__kilo_browser';
const MAX_PAIRING_URL_LENGTH = 4096;
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** What a pairing fragment carries: no key, only a single-use token. */
export type LocalAgentPairingEndpoint = {
  hubId: string;
  token: string;
  ws: string;
};

/** What storage keeps after a successful redemption. */
export type LocalAgentStoredEndpoint = {
  hubId: string;
  key: string;
  ws: string;
};

const uuidSchema = z.uuid();

const pairingFieldsSchema = z.object({
  hub: z.uuid(),
  t: z.string().min(1),
  v: z.literal('1'),
  ws: z.string().min(1),
});

const isLoopbackHostname = (hostname: string): boolean => LOOPBACK_HOSTNAMES.has(hostname);

const readExplicitPort = (url: URL): number | null => {
  if (!/^\d+$/u.test(url.port)) {
    return null;
  }

  const port = Number(url.port);

  return port > 0 && port < 65_536 ? port : null;
};

const parseUrl = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

/**
 * Canonical loopback socket URL, or null. Only plain `ws:` on a loopback host
 * with the hub path qualifies: no credentials, query, hash, or default port.
 */
export const parseLoopbackSocketUrl = (value: string): string | null => {
  const url = parseUrl(value);

  if (url === null || url.protocol !== 'ws:' || !isLoopbackHostname(url.hostname)) {
    return null;
  }

  if (readExplicitPort(url) === null || url.pathname !== HUB_WS_PATH) {
    return null;
  }

  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return null;
  }

  return `ws://${url.hostname}:${url.port}${HUB_WS_PATH}`;
};

/** The HTTP origin a redeem request may target: the socket's own loopback origin. */
export const pairingKeyUrl = (ws: string, token: string): string | null => {
  const canonical = parseLoopbackSocketUrl(ws);

  if (canonical === null) {
    return null;
  }

  const socket = new URL(canonical);
  const redeem = new URL(`http://${socket.host}${PAIRING_KEY_PATH}`);

  redeem.searchParams.set('t', token);

  return redeem.toString();
};

const parseFragment = (hash: string): Record<string, string> | null => {
  if (hash.length < 2) {
    return null;
  }

  const params = new URLSearchParams(hash.slice(1));
  const names = [...params.keys()];

  // Duplicate parameters make the fragment ambiguous; reject rather than pick one.
  if (new Set(names).size !== names.length) {
    return null;
  }

  return Object.fromEntries(params);
};

/** Parses a pairing navigation URL; null for anything this extension must ignore. */
export const parsePairingUrl = (rawUrl: string): LocalAgentPairingEndpoint | null => {
  if (rawUrl.length > MAX_PAIRING_URL_LENGTH) {
    return null;
  }

  const url = parseUrl(rawUrl);

  if (url === null || url.protocol !== 'http:' || !isLoopbackHostname(url.hostname)) {
    return null;
  }

  if (readExplicitPort(url) === null || url.pathname !== PAIRING_PATH) {
    return null;
  }

  const fields = parseFragment(url.hash);

  if (fields === null) {
    return null;
  }

  const parsed = pairingFieldsSchema.safeParse(fields);

  if (!parsed.success || decodePairingNonce(parsed.data.t) === null) {
    return null;
  }

  const ws = parseLoopbackSocketUrl(parsed.data.ws);

  if (ws === null) {
    return null;
  }

  return { hubId: parsed.data.hub, token: parsed.data.t, ws };
};

/**
 * Defense in depth for values read back from storage: an endpoint is only
 * usable when its socket URL and key still satisfy the loopback rules.
 */
export const isUsableStoredEndpoint = (endpoint: LocalAgentStoredEndpoint): boolean =>
  parseLoopbackSocketUrl(endpoint.ws) === endpoint.ws &&
  decodePairingKey(endpoint.key) !== null &&
  uuidSchema.safeParse(endpoint.hubId).success;
