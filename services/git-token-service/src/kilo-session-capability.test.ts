import { encryptWithSymmetricKey } from '@kilocode/encryption';
import { describe, expect, it, vi } from 'vitest';
import { GitHubSessionCapabilityCodec } from './github-session-capability.js';
import {
  KiloSessionCapabilityCodec,
  KiloSessionCapabilityError,
} from './kilo-session-capability.js';

const encryptionKey = Buffer.alloc(32, 7).toString('base64');
const claims = {
  userId: 'user_1',
  cloudAgentSessionId: 'cloud-agent-session-1',
  kiloSessionId: 'kilo-session-1',
  outboundContainerId: 'outbound-container-1',
  userToken: 'raw-user-token-sentinel',
  targets: {
    backendBaseUrl: 'https://api.kilo.ai',
    providerBaseUrl: 'https://api.kilo.ai',
    sessionIngestBaseUrl: 'https://ingest.kilosessions.ai',
  },
} as const;

function encryptedCapability(value: unknown): string {
  return `kka1.${encryptWithSymmetricKey(JSON.stringify(value), encryptionKey)}`;
}

describe('KiloSessionCapabilityCodec', () => {
  it('issues an opaque four-hour capability bound to the session and container', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-07T12:00:00.000Z'));
    const codec = new KiloSessionCapabilityCodec(encryptionKey);

    const capability = codec.issue(claims);

    expect(capability).toMatch(/^kka1\./);
    expect(capability).not.toContain(claims.userToken);
    expect(codec.decode(capability)).toEqual({
      purpose: 'kilo_api_session',
      version: 1,
      ...claims,
      issuedAt: Date.parse('2026-06-07T12:00:00.000Z'),
      expiresAt: Date.parse('2026-06-07T16:00:00.000Z'),
    });
    vi.useRealTimers();
  });

  it.each([
    ['wrong prefix', 'kka2.not-supported'],
    [
      'SCM capability',
      new GitHubSessionCapabilityCodec(encryptionKey).issue({
        userId: 'user_1',
        outboundContainerId: 'outbound-container-1',
        owner: 'acme',
        repo: 'widgets',
        source: 'installation',
        identity: {
          installationId: 'installation_1',
          accountLogin: 'acme',
          appType: 'standard',
          gitAuthor: { name: 'Kilo', email: 'kilo@example.com' },
        },
      }),
    ],
    ['non-canonical ciphertext', 'kka1.AA:AA:AA'],
  ])('rejects %s', (_description, capability) => {
    expect(() => new KiloSessionCapabilityCodec(encryptionKey).decode(capability)).toThrowError(
      expect.objectContaining({ reason: 'invalid_capability' })
    );
  });

  it.each([
    ['wrong purpose', { purpose: 'github_scm_session' }],
    ['unknown claim', { extra: true }],
    ['unknown target claim', { targets: { ...claims.targets, extra: true } }],
    ['invalid timestamp order', { issuedAt: 2, expiresAt: 1 }],
    ['excessive lifetime', { issuedAt: 1, expiresAt: 1 + 4 * 60 * 60 * 1000 + 1 }],
  ])('rejects decrypted claims with %s', (_description, override) => {
    const issuedAt = Date.now();
    const base = {
      purpose: 'kilo_api_session',
      version: 1,
      ...claims,
      issuedAt,
      expiresAt: issuedAt + 60_000,
    };
    const capability = encryptedCapability({ ...base, ...override });

    expect(() => new KiloSessionCapabilityCodec(encryptionKey).decode(capability)).toThrowError(
      expect.objectContaining({ reason: 'invalid_capability' })
    );
  });

  it('rejects oversized encrypted claims', () => {
    const issuedAt = Date.now();
    const capability = encryptedCapability({
      purpose: 'kilo_api_session',
      version: 1,
      ...claims,
      userToken: 'x'.repeat(70_000),
      issuedAt,
      expiresAt: issuedAt + 60_000,
    });

    expect(() => new KiloSessionCapabilityCodec(encryptionKey).decode(capability)).toThrowError(
      expect.objectContaining({ reason: 'invalid_capability' })
    );
  });

  it('rejects a capability issued beyond the clock-skew tolerance', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-07T12:00:00.000Z'));
    const issuedAt = Date.now() + 5 * 60_000;
    const capability = encryptedCapability({
      purpose: 'kilo_api_session',
      version: 1,
      ...claims,
      issuedAt,
      expiresAt: issuedAt + 60_000,
    });

    expect(() => new KiloSessionCapabilityCodec(encryptionKey).decode(capability)).toThrowError(
      expect.objectContaining({ reason: 'invalid_capability' })
    );
    vi.useRealTimers();
  });

  it('accepts a capability issued within the clock-skew tolerance', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-07T12:00:00.000Z'));
    const issuedAt = Date.now() + 30_000;
    const capability = encryptedCapability({
      purpose: 'kilo_api_session',
      version: 1,
      ...claims,
      issuedAt,
      expiresAt: issuedAt + 60_000,
    });

    expect(new KiloSessionCapabilityCodec(encryptionKey).decode(capability)).toMatchObject({
      issuedAt,
    });
    vi.useRealTimers();
  });

  it('rejects expiry and tampering without exposing enclosed tokens in errors', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-07T12:00:00.000Z'));
    const codec = new KiloSessionCapabilityCodec(encryptionKey);
    const capability = codec.issue(claims);

    vi.setSystemTime(new Date('2026-06-07T16:00:00.000Z'));
    let expiredError: unknown;
    try {
      codec.decode(capability);
    } catch (error) {
      expiredError = error;
    }
    expect(expiredError).toBeInstanceOf(KiloSessionCapabilityError);
    expect(expiredError).toMatchObject({ reason: 'expired_capability' });
    expect(JSON.stringify(expiredError)).not.toContain(claims.userToken);

    const changedOffset = capability.lastIndexOf('.') + 4;
    const changedCharacter = capability[changedOffset] === 'A' ? 'B' : 'A';
    const tampered = `${capability.slice(0, changedOffset)}${changedCharacter}${capability.slice(changedOffset + 1)}`;
    expect(() => codec.decode(tampered)).toThrowError(
      expect.objectContaining({ reason: 'invalid_capability' })
    );
    vi.useRealTimers();
  });
});
