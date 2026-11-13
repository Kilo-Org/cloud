import { describe, expect, it } from 'vitest';

import { MAX_RECONNECT_ATTEMPTS, reconnectDelayMs } from './backoff';
import { isRetryableReason, needsPrompt, type SshSessionPhase } from './types';

describe('reconnectDelayMs', () => {
  it('starts at one second and doubles', () => {
    expect([1, 2, 3, 4].map(reconnectDelayMs)).toEqual([1000, 2000, 4000, 8000]);
  });

  it('caps the wait so a long outage does not sleep forever', () => {
    expect(reconnectDelayMs(9)).toBe(30_000);
    expect(reconnectDelayMs(32)).toBe(30_000);
  });

  it('keeps the attempt budget small enough to give up', () => {
    expect(MAX_RECONNECT_ATTEMPTS).toBe(5);
  });
});

describe('isRetryableReason', () => {
  it('retries only transport failures', () => {
    expect(isRetryableReason('Network')).toBe(true);
    expect(isRetryableReason('Timeout')).toBe(true);
    expect(isRetryableReason('ChannelClosed')).toBe(true);
    expect(isRetryableReason('disconnected')).toBe(true);
    expect(isRetryableReason('AuthFailed')).toBe(false);
    expect(isRetryableReason('HostKeyRejected')).toBe(false);
    expect(isRetryableReason('user')).toBe(false);
  });
});

describe('needsPrompt', () => {
  const hostKey = {
    requestId: 'request',
    hostPattern: 'web-1.kilo.test',
    algorithm: 'ssh-ed25519',
    publicKeyBase64: 'AAAAC3NzaC1lZDI1NTE5AAAAIOffered',
    fingerprintSha256: 'SHA256:offered',
    knownFingerprintSha256: null,
  };

  it('asks about an unknown host key', () => {
    expect(needsPrompt({ kind: 'awaiting-host-key', hostKey })).toBe(true);
  });

  it('does not ask about a changed host key: that state has no accept', () => {
    expect(
      needsPrompt({
        kind: 'awaiting-host-key',
        hostKey: { ...hostKey, knownFingerprintSha256: 'SHA256:stored' },
      })
    ).toBe(false);
  });

  it('asks for a password, a passphrase and the server prompts', () => {
    const prompting: SshSessionPhase[] = [
      { kind: 'awaiting-password', failed: false },
      { kind: 'awaiting-passphrase', failed: true },
      {
        kind: 'awaiting-prompts',
        prompts: { requestId: 'request', name: '', instructions: '', prompts: [] },
      },
    ];
    for (const phase of prompting) {
      expect(needsPrompt(phase)).toBe(true);
    }
  });

  it('asks nothing while connecting, connected or closed', () => {
    const quiet: SshSessionPhase[] = [
      { kind: 'connecting', attempt: 1 },
      { kind: 'connected' },
      { kind: 'reconnecting', attempt: 2, reason: 'Network' },
      { kind: 'closed', reason: 'Network', retryable: true },
    ];
    for (const phase of quiet) {
      expect(needsPrompt(phase)).toBe(false);
    }
  });
});
