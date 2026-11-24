import {
  AI_ATTRIBUTION_AUDIENCE,
  CLOUD_AGENT_NEXT_AUDIENCE,
  EVENT_SERVICE_AUDIENCE,
  KILO_API_AUDIENCE,
  KILO_CHAT_AUDIENCE,
  KILO_GATEWAY_AUDIENCE,
  KILOCLAW_AUDIENCE,
  NOTIFICATIONS_AUDIENCE,
  PAGES_AUDIENCE,
  PAGES_DEV_AUDIENCE,
  SESSION_INGEST_AUDIENCE,
  SESSION_INGEST_USER_DELETION_AUDIENCE,
  USER_DATA_EXPORT_AUDIENCE,
} from './internal-service-token-audiences';
import { SESSION_TRANSCRIPT_TOKEN_AUDIENCE } from './cloud-agent-session-sync';

export const KILO_TOKEN_PURPOSES = [
  'human-api',
  'device-access',
  'delegated-workload',
  'internal-service',
] as const;
export type KiloTokenPurpose = (typeof KILO_TOKEN_PURPOSES)[number];

export const KILO_TOKEN_ISSUER_IDS = [
  'kilo-web',
  'cloud-agent-next',
  'security-auto-analysis',
  'webhook-agent-ingest',
  'kiloclaw',
] as const;
export type KiloTokenIssuerId = (typeof KILO_TOKEN_ISSUER_IDS)[number];

/** The issuers one verification call site accepts. It is never empty. */
export type KiloTokenAcceptedIssuers = readonly [KiloTokenIssuerId, ...KiloTokenIssuerId[]];

export type KiloTokenIssuerPolicy = {
  readonly allowedAudiences: readonly string[];
  /** Every audience that starts with one of these prefixes is allowed too. */
  readonly allowedAudiencePrefixes: readonly string[];
  readonly allowedPurposes: readonly KiloTokenPurpose[];
  /** Whether the issuer may sign tokens without `tokenPurpose` or without `aud`. */
  readonly allowsLegacyShape: boolean;
};

/**
 * What each issuer may sign. A token signed by an issuer's key must stay within
 * its policy, so widening an issuer is a deliberate code change and redeploy.
 */
export const KILO_TOKEN_ISSUERS: Readonly<Record<KiloTokenIssuerId, KiloTokenIssuerPolicy>> = {
  'kilo-web': {
    allowedAudiences: [
      KILO_API_AUDIENCE,
      KILO_GATEWAY_AUDIENCE,
      CLOUD_AGENT_NEXT_AUDIENCE,
      SESSION_INGEST_AUDIENCE,
      SESSION_INGEST_USER_DELETION_AUDIENCE,
      USER_DATA_EXPORT_AUDIENCE,
      AI_ATTRIBUTION_AUDIENCE,
      KILOCLAW_AUDIENCE,
      KILO_CHAT_AUDIENCE,
      EVENT_SERVICE_AUDIENCE,
      NOTIFICATIONS_AUDIENCE,
      PAGES_AUDIENCE,
      PAGES_DEV_AUDIENCE,
      'cloud-agent-stream',
      'cloud-agent-terminal',
      'cloud-agent-preview',
      SESSION_TRANSCRIPT_TOKEN_AUDIENCE,
    ],
    allowedAudiencePrefixes: ['git-token-service:'],
    allowedPurposes: KILO_TOKEN_PURPOSES,
    allowsLegacyShape: true,
  },
  'cloud-agent-next': {
    allowedAudiences: [KILO_API_AUDIENCE, KILO_GATEWAY_AUDIENCE, SESSION_INGEST_AUDIENCE],
    allowedAudiencePrefixes: [],
    allowedPurposes: ['delegated-workload'],
    allowsLegacyShape: false,
  },
  'security-auto-analysis': {
    allowedAudiences: [CLOUD_AGENT_NEXT_AUDIENCE, KILO_GATEWAY_AUDIENCE, SESSION_INGEST_AUDIENCE],
    allowedAudiencePrefixes: [],
    allowedPurposes: ['internal-service'],
    allowsLegacyShape: false,
  },
  'webhook-agent-ingest': {
    allowedAudiences: [CLOUD_AGENT_NEXT_AUDIENCE],
    allowedAudiencePrefixes: [],
    allowedPurposes: ['internal-service'],
    allowsLegacyShape: false,
  },
  kiloclaw: {
    allowedAudiences: [KILO_GATEWAY_AUDIENCE, KILO_API_AUDIENCE, SESSION_INGEST_AUDIENCE],
    allowedAudiencePrefixes: [],
    allowedPurposes: ['delegated-workload'],
    allowsLegacyShape: false,
  },
};
