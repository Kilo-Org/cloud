/* eslint-disable eslint/id-length, typescript-eslint/consistent-type-definitions -- `v` is the wire field; AGENTS.md prefers type over interface */
import { z } from 'zod';
import { decodePairingKey } from './encoding';
import { pairingKeyUrl, parseLoopbackSocketUrl } from './pairing';
import type { LocalAgentStoredEndpoint } from './pairing';

/*
 * Redeems a single-use pairing token for its key (SPEC "Loopback pairing").
 * Failures are domain states, not exceptions: 403 means this extension origin
 * is not allowlisted, 404 means the token is unknown, expired, or already used.
 */

export type LocalAgentRedeemFailure = 'expired' | 'invalid' | 'not_allowed';

export type LocalAgentRedeemResult =
  | { ok: true; endpoint: LocalAgentStoredEndpoint }
  | { ok: false; reason: LocalAgentRedeemFailure };

export type LocalAgentFetchResponse = {
  status: number;
  json(): Promise<Record<string, unknown> | null>;
};

export type LocalAgentFetchInit = {
  method: 'POST';
  headers: { 'content-type': 'application/json' };
  body: string;
};

export type LocalAgentFetch = (
  url: string,
  init: LocalAgentFetchInit
) => Promise<LocalAgentFetchResponse>;

const bodySchema = z.object({
  key: z.string().min(1),
  v: z.literal(1),
  ws: z.string().min(1),
});

export const redeemPairingKey = async ({
  fetchImpl,
  hubId,
  token,
  ws,
}: {
  fetchImpl: LocalAgentFetch;
  hubId: string;
  token: string;
  ws: string;
}): Promise<LocalAgentRedeemResult> => {
  const url = pairingKeyUrl(ws);

  if (url === null) {
    return { ok: false, reason: 'invalid' };
  }

  let response: LocalAgentFetchResponse | null = null;

  // A POST with a JSON body makes Chrome attach the extension origin.
  // A plain GET from the worker carries no Origin at all.
  try {
    response = await fetchImpl(url, {
      body: JSON.stringify({ t: token }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
  } catch {
    return { ok: false, reason: 'invalid' };
  }

  if (response === null) {
    return { ok: false, reason: 'invalid' };
  }

  if (response.status === 403) {
    return { ok: false, reason: 'not_allowed' };
  }

  if (response.status === 404) {
    return { ok: false, reason: 'expired' };
  }

  if (response.status !== 200) {
    return { ok: false, reason: 'invalid' };
  }

  let payload: Record<string, unknown> | null = null;

  try {
    payload = await response.json();
  } catch {
    return { ok: false, reason: 'invalid' };
  }

  const parsed = bodySchema.safeParse(payload);

  if (!parsed.success || decodePairingKey(parsed.data.key) === null) {
    return { ok: false, reason: 'invalid' };
  }

  const redeemedWs = parseLoopbackSocketUrl(parsed.data.ws);
  const requestedWs = parseLoopbackSocketUrl(ws);

  // The response may name a different loopback hub path only if it is still loopback.
  if (redeemedWs === null || requestedWs === null) {
    return { ok: false, reason: 'invalid' };
  }

  return { endpoint: { hubId, key: parsed.data.key, ws: redeemedWs }, ok: true };
};
