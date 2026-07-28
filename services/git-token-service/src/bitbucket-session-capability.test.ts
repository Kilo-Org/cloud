import { describe, expect, it, vi } from 'vitest';
import {
  BitbucketSessionCapabilityCodec,
  BitbucketSessionCapabilityError,
  isBitbucketSessionCapability,
} from './bitbucket-session-capability.js';

const encryptionKey = Buffer.alloc(32, 7).toString('base64');
const anotherEncryptionKey = Buffer.alloc(32, 8).toString('base64');
const subject = {
  userId: 'user_1',
  orgId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145b',
  integrationId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145c',
  workspaceUuid: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145d',
  workspaceSlug: 'acme',
  repositoryUuid: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145e',
  repositoryFullName: 'acme/widgets',
  tokenDigest: 'f30b0bf364d41460c0119e521d2af8ae7eeacca9745981678d58b07b13c94edf',
  outboundContainerId: 'outbound-container-1',
} as const;

describe('BitbucketSessionCapabilityCodec', () => {
  it('produces an opaque four-hour prefixed capability that round-trips', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-31T12:00:00.000Z'));
    const codec = new BitbucketSessionCapabilityCodec(encryptionKey);

    const capability = codec.issue(subject);

    expect(capability).toMatch(/^kbb1\./);
    expect(isBitbucketSessionCapability(capability)).toBe(true);
    // The raw workspace/token material must not appear in the opaque capability.
    expect(capability).not.toContain('user_1');
    expect(capability).not.toContain('acme/widgets');
    expect(capability).not.toContain(subject.tokenDigest);
    expect(codec.decode(capability)).toEqual({
      purpose: 'bitbucket_scm_session',
      version: 1,
      ...subject,
      issuedAt: Date.parse('2026-05-31T12:00:00.000Z'),
      expiresAt: Date.parse('2026-05-31T16:00:00.000Z'),
    });
    vi.useRealTimers();
  });

  it('rejects a capability encrypted with a different key', () => {
    const capability = new BitbucketSessionCapabilityCodec(encryptionKey).issue(subject);
    expect(() =>
      new BitbucketSessionCapabilityCodec(anotherEncryptionKey).decode(capability)
    ).toThrow(new BitbucketSessionCapabilityError('invalid_capability'));
  });

  it('rejects a value without the bitbucket prefix', () => {
    const codec = new BitbucketSessionCapabilityCodec(encryptionKey);
    expect(isBitbucketSessionCapability('kgl2.something')).toBe(false);
    expect(() => codec.decode('kgl2.something')).toThrow(
      new BitbucketSessionCapabilityError('invalid_capability')
    );
  });

  it('rejects an expired capability', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-31T12:00:00.000Z'));
    const codec = new BitbucketSessionCapabilityCodec(encryptionKey);
    const capability = codec.issue(subject);

    vi.setSystemTime(new Date('2026-05-31T16:00:00.001Z'));
    expect(() => codec.decode(capability)).toThrow(
      new BitbucketSessionCapabilityError('expired_capability')
    );
    vi.useRealTimers();
  });
});
