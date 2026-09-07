import type { EnkryptScore } from '@kilocode/db/schema-types';
import { fingerprintEnkryptScore } from './enkrypt-fingerprint';

const score: EnkryptScore = {
  model_name: 'fixture-model',
  provider: 'fixture-provider',
  source: '',
  risk_score: 0,
  safety_score: null,
};

describe('fingerprintEnkryptScore', () => {
  it('produces a deterministic SHA-256 fingerprint', () => {
    expect(fingerprintEnkryptScore(score)).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintEnkryptScore({ ...score })).toBe(fingerprintEnkryptScore(score));
  });

  it('ignores object key order, transport fields, and ingestion timestamps', () => {
    const reordered = {
      safety_score: null,
      risk_score: 0,
      source: '',
      provider: score.provider,
      model_name: score.model_name,
      ingestedAt: '2026-09-01T04:00:00.000Z',
      evaluatedAt: null,
      transportMetadata: 'ignored',
    };
    expect(fingerprintEnkryptScore(reordered)).toBe(fingerprintEnkryptScore(score));
  });

  it.each([
    { risk_score: 1 },
    { risk_score: null },
    { safety_score: 0 },
    { source: null },
    { source: 'new source' },
    { provider: 'different-provider' },
    { model_name: 'fixture-model:reasoning' },
  ])('detects a content or provenance change: %p', difference => {
    expect(fingerprintEnkryptScore({ ...score, ...difference })).not.toBe(
      fingerprintEnkryptScore(score)
    );
  });

  it('preserves the distinction between an empty and an absent source', () => {
    const withoutSource = { ...score };
    delete withoutSource.source;
    expect(fingerprintEnkryptScore(withoutSource)).not.toBe(fingerprintEnkryptScore(score));
  });

  it('rejects invalid numeric values before hashing', () => {
    expect(() => fingerprintEnkryptScore({ ...score, risk_score: NaN })).toThrow();
  });
});
