import { KILO_WEB_CLIENT_ID } from '@kilocode/uts-contracts';
import type { UtsConfig } from '../env';
import type { FeedPublish } from '../revocation/publish';
import type { MintClient, ScopeRegistry } from '../scopes/policy';
import type { SignerAccess } from '../token/mint';
import type { WebClientKeys } from './client-auth';
import type { HandleWindows } from './limits';
import type { WebSessionAccess } from './store';

/** `kilo-web` as the scope registry's `allowedClients` names it. */
export const WEB_MINT_CLIENT: MintClient = {
  kind: 'confidential_web',
  clientId: KILO_WEB_CLIENT_ID,
};

/**
 * The WorkOS ids a legacy bridge subject token names, which the web app verified server-side.
 * `verified` only when UTS's own authority data maps that connection to that organization and the
 * account holds an active membership there (slice 3.17 holds that data); `unverified` otherwise.
 */
export type LegacySsoClaim = {
  subject: string;
  connection: string;
  organization: string | null;
};
export type LegacySsoAuthority = (claim: LegacySsoClaim) => Promise<'verified' | 'unverified'>;

/**
 * The authority check until UTS holds the SSO authority data (slice 3.17): it confirms nothing,
 * so a bridged session never carries SSO provenance and org-bound access needs a real SSO sign-in.
 */
export const noSsoAuthority: LegacySsoAuthority = async () => 'unverified';

/**
 * The legacy bridge runs only where `LEGACY_BRIDGE_ENABLED` is `true`, and verifies its subject
 * tokens only under its own key set (`KILO_WEB_BRIDGE_JWKS`, `legacyBridgeKeys`): while that set
 * is unset, invalid or shares a key with the client set, the bridge answers 503, so removing the
 * bridge key turns the bridge off.
 */
export type LegacyBridge =
  | { status: 'off' }
  | { status: 'on'; authority: LegacySsoAuthority; keys: () => Promise<WebClientKeys> };

/** What the `kilo-web` token grants and the browser-session API need. */
export type WebClientDeps = {
  config: UtsConfig;
  /** The public keys of `KILO_WEB_CLIENT_JWKS` (`webClientKeys`). */
  keys: () => Promise<WebClientKeys>;
  sessions: WebSessionAccess;
  sign: SignerAccess;
  scopes: ScopeRegistry;
  publish: FeedPublish;
  bridge: LegacyBridge;
  /** Per-isolate call windows of each session handle (src/bff/limits.ts). */
  windows: HandleWindows;
  /** Milliseconds since the epoch. */
  now: () => number;
};
