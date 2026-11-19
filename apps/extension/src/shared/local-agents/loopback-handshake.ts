/* eslint-disable typescript-eslint/consistent-type-definitions -- AGENTS.md prefers type over interface */
import {
  computeExtensionMac,
  createPairingNonce,
  decodePairingKey,
  decodePairingNonce,
  verifyHubMac,
} from './encoding';

/*
 * The loopback handshake from SPEC "Loopback pairing": the hub sends a 16-byte
 * challenge, the extension answers with a fresh 16-byte nonce and the MAC, and
 * the hub proves the key with its own MAC. Kept separate from the socket so the
 * MAC logic is unit-tested with fixed vectors.
 */

export type LocalAgentAuthFrame = {
  type: 'auth';
  hubId: string;
  nonceE: string;
  mac: string;
};

export type LocalAgentLoopbackHandshake = {
  /** Returns the auth frame for the hub, or null when the challenge is malformed. */
  acceptChallenge(nonceH: string): Promise<LocalAgentAuthFrame | null>;
  /** True only when the hub MAC matches and a challenge was answered first. */
  acceptAuthOk(mac: string): Promise<boolean>;
};

export const createLoopbackHandshake = ({
  createNonce = createPairingNonce,
  hubId,
  key,
}: {
  createNonce?: () => string;
  hubId: string;
  key: string;
}): LocalAgentLoopbackHandshake | null => {
  const keyBytes = decodePairingKey(key);

  if (keyBytes === null) {
    return null;
  }

  let nonceH: string | null = null;
  let nonceE: string | null = null;

  return {
    acceptAuthOk: (mac: string): Promise<boolean> => {
      if (nonceH === null || nonceE === null) {
        return Promise.resolve(false);
      }

      return verifyHubMac({ key: keyBytes, mac, nonceE, nonceH });
    },

    acceptChallenge: async (challenge: string): Promise<LocalAgentAuthFrame | null> => {
      if (decodePairingNonce(challenge) === null) {
        return null;
      }

      const extensionNonce = createNonce();

      if (decodePairingNonce(extensionNonce) === null) {
        return null;
      }

      nonceH = challenge;
      nonceE = extensionNonce;

      return {
        hubId,
        mac: await computeExtensionMac(keyBytes, challenge, extensionNonce),
        nonceE: extensionNonce,
        type: 'auth',
      };
    },
  };
};
