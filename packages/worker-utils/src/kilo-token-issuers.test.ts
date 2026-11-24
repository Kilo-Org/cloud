import { describe, it, expect } from 'vitest';
import {
  KILO_TOKEN_ISSUER_IDS,
  KILO_TOKEN_ISSUERS,
  KILO_TOKEN_PURPOSES,
} from './kilo-token-issuers.js';

describe('KILO_TOKEN_ISSUERS', () => {
  it('registers exactly the known issuers', () => {
    expect(Object.keys(KILO_TOKEN_ISSUERS).sort()).toEqual([...KILO_TOKEN_ISSUER_IDS].sort());
  });

  it('lets only kilo-web sign the legacy shape or every purpose', () => {
    for (const id of KILO_TOKEN_ISSUER_IDS) {
      const policy = KILO_TOKEN_ISSUERS[id];
      expect(policy.allowsLegacyShape).toBe(id === 'kilo-web');
      if (id !== 'kilo-web') {
        expect(policy.allowedPurposes).toHaveLength(1);
        expect(policy.allowedAudiencePrefixes).toEqual([]);
      }
    }
    expect(KILO_TOKEN_ISSUERS['kilo-web'].allowedPurposes).toEqual(KILO_TOKEN_PURPOSES);
  });

  it('matches the issuer table', () => {
    expect(KILO_TOKEN_ISSUERS['cloud-agent-next']).toEqual({
      allowedAudiences: ['kilo-api', 'kilo-gateway', 'session-ingest'],
      allowedAudiencePrefixes: [],
      allowedPurposes: ['delegated-workload'],
      allowsLegacyShape: false,
    });
    expect(KILO_TOKEN_ISSUERS['security-auto-analysis']).toEqual({
      allowedAudiences: ['cloud-agent-next', 'kilo-gateway', 'session-ingest'],
      allowedAudiencePrefixes: [],
      allowedPurposes: ['internal-service'],
      allowsLegacyShape: false,
    });
    expect(KILO_TOKEN_ISSUERS['webhook-agent-ingest']).toEqual({
      allowedAudiences: ['cloud-agent-next'],
      allowedAudiencePrefixes: [],
      allowedPurposes: ['internal-service'],
      allowsLegacyShape: false,
    });
    expect(KILO_TOKEN_ISSUERS.kiloclaw).toEqual({
      allowedAudiences: ['kilo-gateway', 'kilo-api', 'session-ingest'],
      allowedAudiencePrefixes: [],
      allowedPurposes: ['delegated-workload'],
      allowsLegacyShape: false,
    });
    expect([...KILO_TOKEN_ISSUERS['kilo-web'].allowedAudiences].sort()).toEqual(
      [
        'kilo-api',
        'kilo-gateway',
        'cloud-agent-next',
        'session-ingest',
        'session-ingest:user-deletion',
        'user-data-export',
        'ai-attribution',
        'kiloclaw',
        'kilo-chat',
        'event-service',
        'notifications',
        'pages',
        'pages-dev',
        'cloud-agent-stream',
        'cloud-agent-terminal',
        'cloud-agent-preview',
        'session-sync:transcript',
      ].sort()
    );
    expect(KILO_TOKEN_ISSUERS['kilo-web'].allowedAudiencePrefixes).toEqual(['git-token-service:']);
  });

  it('does not allow the removed html-deploy audience', () => {
    for (const id of KILO_TOKEN_ISSUER_IDS) {
      expect(KILO_TOKEN_ISSUERS[id].allowedAudiences).not.toContain('deploy-builder:html-deploy');
    }
  });

  it('has no duplicate audiences', () => {
    for (const id of KILO_TOKEN_ISSUER_IDS) {
      const { allowedAudiences } = KILO_TOKEN_ISSUERS[id];
      expect(new Set(allowedAudiences).size).toBe(allowedAudiences.length);
    }
  });
});
