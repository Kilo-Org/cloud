/* eslint-disable eslint/id-length, typescript-eslint/consistent-type-definitions -- fragment keys `k` and `v` are wire names; AGENTS.md prefers type over interface */
import { z } from 'zod';
import { decodePairingKey } from './encoding';

/*
 * Loopback pairing boundary (SPEC "Loopback pairing"). The CLI opens
 * `http://127.0.0.1:<port>/__kilo_browser_pair#v=1&hub=<hubId>&k=<key>&ws=<ws url>`;
 * the extension watches tab navigations for that path, keeps only loopback
 * socket URLs with a 32-byte key, and never stores or logs anything else.
 */

export const PAIRING_PATH = '/__kilo_browser_pair';
export const HUB_WS_PATH = '/__kilo_browser';
const MAX_PAIRING_URL_LENGTH = 4096;
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

export type LocalAgentPairingEndpoint = {
  hubId: string;
  ws: string;
  key: string;
};

const uuidSchema = z.uuid();

const pairingFieldsSchema = z.object({
  hub: z.uuid(),
  k: z.string().min(1),
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

  if (!parsed.success || decodePairingKey(parsed.data.k) === null) {
    return null;
  }

  const ws = parseLoopbackSocketUrl(parsed.data.ws);

  if (ws === null) {
    return null;
  }

  return { hubId: parsed.data.hub, key: parsed.data.k, ws };
};

/**
 * Defense in depth for values read back from storage: an endpoint is only
 * usable when its socket URL and key still satisfy the loopback rules.
 */
export const isUsablePairingEndpoint = (endpoint: LocalAgentPairingEndpoint): boolean =>
  parseLoopbackSocketUrl(endpoint.ws) === endpoint.ws &&
  decodePairingKey(endpoint.key) !== null &&
  uuidSchema.safeParse(endpoint.hubId).success;
