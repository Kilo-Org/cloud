import { describe, expect, it } from 'vitest';
import {
  getSandboxProviderLabel,
  safeSandboxRuntimeVersion,
  SandboxRuntimeMetadataSchema,
  SANDBOX_STATUS_DETAIL_MESSAGES,
  SandboxStatusSnapshotSchema,
  SandboxStatusSessionIdSchema,
  type SandboxStatusSnapshot,
} from './sandbox-status.js';

const observedAt = 1_800_000_000_000;
const snapshot = {
  status: 'active',
  provider: 'Cloudflare',
  observedAt,
  detailCode: 'sandbox_ready',
  inactivityTimeoutMs: 300_000,
  estimatedSleepAt: null,
} satisfies SandboxStatusSnapshot;

const lifecycleCases = [
  { status: 'active', detailCode: 'sandbox_ready' },
  { status: 'sleeping', detailCode: 'sandbox_stopped' },
  { status: 'starting', detailCode: 'sandbox_starting' },
  { status: 'stopping', detailCode: 'sandbox_stopping' },
  { status: 'error', detailCode: 'sandbox_failed' },
  { status: 'unreachable', detailCode: 'connection_unavailable' },
  { status: 'unknown', detailCode: 'insufficient_evidence' },
  { status: 'unknown', detailCode: 'status_unavailable' },
] satisfies Pick<SandboxStatusSnapshot, 'status' | 'detailCode'>[];

const invalidNumbers = [NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '123'];

const privateFields = {
  sessionId: 'agent_private-session',
  sandboxId: 'usr-private-sandbox',
  providerInstanceId: 'private-instance',
  wrapperRunId: 'private-wrapper',
  userId: 'private-owner',
  orgId: 'private-organization',
  region: 'private-region',
  url: 'https://private-runtime.invalid',
  credentials: { token: 'private-credential' },
  headers: { Authorization: 'Bearer private-credential' },
  error: new Error('private-provider-failure'),
  message: 'private-provider-failure',
};

describe('SandboxStatusSessionIdSchema', () => {
  it.each([
    'workspace_12345678-1234-4234-9234-123456789abc',
    'workspace_ABCDEF01-2345-6789-ABCD-EF0123456789',
  ])('accepts a valid control-plane reference %s', sessionId => {
    expect(SandboxStatusSessionIdSchema.parse(sessionId)).toBe(sessionId);
  });

  it.each([
    'agent_12345678-1234-4234-9234-123456789abc',
    'sess_12345678-1234-4234-9234-123456789abc',
    'ses_12345678901234567890123456',
    '12345678-1234-4234-9234-123456789abc',
    'workspace_',
    'workspace_pending',
    'workspace_../../private',
    'workspace_zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz',
    'workspace_12345678-1234-4234-9234-123456789ab',
    'workspace_12345678-1234-4234-9234-123456789abc\n',
    ' workspace_12345678-1234-4234-9234-123456789abc',
    '',
  ])('rejects legacy, unrelated, and malformed reference %s', sessionId => {
    expect(SandboxStatusSessionIdSchema.safeParse(sessionId).success).toBe(false);
  });
});

describe('sandbox status public contract', () => {
  it.each(lifecycleCases)('accepts $status with $detailCode', lifecycle => {
    const input = { ...snapshot, ...lifecycle };
    expect(SandboxStatusSnapshotSchema.parse(input)).toEqual(input);
  });

  it.each(['Cloudflare', 'Vercel', 'Unknown'])(
    'accepts only a bounded provider label: %s',
    provider => {
      expect(SandboxStatusSnapshotSchema.parse({ ...snapshot, provider }).provider).toBe(provider);
    }
  );

  it('strips private fields from the serialized response', () => {
    const parsed = SandboxStatusSnapshotSchema.parse({ ...snapshot, ...privateFields });
    expect(parsed).toStrictEqual(snapshot);
    expect(JSON.stringify(parsed)).not.toContain('private');
  });

  it.each(['status', 'provider', 'detailCode'] as const)('rejects arbitrary text in %s', field => {
    expect(
      SandboxStatusSnapshotSchema.safeParse({ ...snapshot, [field]: 'private-provider-failure' })
        .success
    ).toBe(false);
  });

  it.each(['loading', 'healthy', 'destroyed', 'running', 'failed', 'idle', 'settling'])(
    'does not treat loading, agent progress, or billing phase %s as a lifecycle status',
    status => {
      expect(SandboxStatusSnapshotSchema.safeParse({ ...snapshot, status }).success).toBe(false);
    }
  );

  it.each(lifecycleCases)('rejects contradictory details for $status/$detailCode', lifecycle => {
    expect(
      SandboxStatusSnapshotSchema.safeParse({
        ...snapshot,
        ...lifecycle,
        status: lifecycle.status === 'active' ? 'unknown' : 'active',
      }).success
    ).toBe(false);
  });

  it('distinguishes failed observation from a confirmed sandbox failure', () => {
    expect(
      SandboxStatusSnapshotSchema.safeParse({
        ...snapshot,
        status: 'error',
        detailCode: 'status_unavailable',
      }).success
    ).toBe(false);
    expect(SANDBOX_STATUS_DETAIL_MESSAGES.status_unavailable).toBe(
      'Sandbox status is temporarily unavailable. This does not mean the sandbox failed.'
    );
    expect(SANDBOX_STATUS_DETAIL_MESSAGES.sandbox_failed).toBe(
      'The sandbox encountered an error. Send a message to try again.'
    );
  });

  it.each(['observedAt', 'estimatedSleepAt'] as const)(
    'validates %s as a finite timestamp',
    field => {
      for (const invalid of [...invalidNumbers, 8_640_000_000_000_001]) {
        expect(
          SandboxStatusSnapshotSchema.safeParse({ ...snapshot, [field]: invalid }).success
        ).toBe(false);
      }
    }
  );

  it('requires finite positive whole-millisecond inactivity durations', () => {
    for (const invalid of [...invalidNumbers, 0]) {
      expect(
        SandboxStatusSnapshotSchema.safeParse({ ...snapshot, inactivityTimeoutMs: invalid }).success
      ).toBe(false);
    }
    expect(
      SandboxStatusSnapshotSchema.safeParse({ ...snapshot, inactivityTimeoutMs: 1 }).success
    ).toBe(true);
  });

  it('allows unknown timing without fabricating a deadline', () => {
    expect(
      SandboxStatusSnapshotSchema.parse({ ...snapshot, inactivityTimeoutMs: null })
    ).toStrictEqual({
      ...snapshot,
      inactivityTimeoutMs: null,
    });
  });

  it.each([
    'status',
    'provider',
    'observedAt',
    'detailCode',
    'inactivityTimeoutMs',
    'estimatedSleepAt',
  ])('requires the explicit %s field, including nullable timing', field => {
    const input: Record<string, unknown> = { ...snapshot };
    delete input[field];
    expect(SandboxStatusSnapshotSchema.safeParse(input).success).toBe(false);
  });

  it('accepts a future approximate deadline for an active sandbox with a known policy', () => {
    const input = { ...snapshot, estimatedSleepAt: observedAt + 60_000 };
    expect(SandboxStatusSnapshotSchema.parse(input)).toEqual(input);
  });

  it.each([observedAt - 1, observedAt])('rejects an expired estimate: %s', estimatedSleepAt => {
    expect(SandboxStatusSnapshotSchema.safeParse({ ...snapshot, estimatedSleepAt }).success).toBe(
      false
    );
  });

  it('rejects an estimate without an inactivity policy', () => {
    expect(
      SandboxStatusSnapshotSchema.safeParse({
        ...snapshot,
        inactivityTimeoutMs: null,
        estimatedSleepAt: observedAt + 60_000,
      }).success
    ).toBe(false);
  });

  it.each(lifecycleCases.filter(lifecycle => lifecycle.status !== 'active'))(
    'rejects estimates for $status/$detailCode',
    lifecycle => {
      expect(
        SandboxStatusSnapshotSchema.safeParse({
          ...snapshot,
          ...lifecycle,
          estimatedSleepAt: observedAt + 60_000,
        }).success
      ).toBe(false);
    }
  );
});

describe('optional sandbox runtime metadata', () => {
  const runtime = {
    sandboxType: 'isolated-standard',
    kiloCliVersion: '7.4.20',
    wrapperVersion: '2.4.0',
    startedAt: observedAt - 100_000,
    stoppedAt: null,
  };

  it('retains the six-field contract and allows explicit unknown runtime metadata', () => {
    expect(SandboxStatusSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    const unknown = Object.fromEntries(Object.keys(runtime).map(key => [key, null]));
    expect(SandboxStatusSnapshotSchema.parse({ ...snapshot, runtime: unknown }).runtime).toEqual(
      unknown
    );
    expect(SandboxStatusSnapshotSchema.parse({ ...snapshot, runtime }).runtime).toEqual(runtime);
  });

  it.each(Object.keys(runtime))(
    'requires nullable runtime field %s when runtime is present',
    field => {
      const input: Record<string, unknown> = { ...runtime };
      delete input[field];
      expect(SandboxRuntimeMetadataSchema.safeParse(input).success).toBe(false);
    }
  );

  it.each([
    'shared',
    'isolated-small',
    'isolated-standard',
    'code-review',
    'devcontainer',
    'unknown',
  ])('accepts bounded sandbox type %s', sandboxType => {
    expect(SandboxRuntimeMetadataSchema.parse({ ...runtime, sandboxType }).sandboxType).toBe(
      sandboxType
    );
  });

  it.each(['legacy-shared', 'private-sandbox', 'https://runtime.invalid', 'standard'])(
    'rejects non-public sandbox type %s',
    sandboxType => {
      expect(SandboxRuntimeMetadataSchema.safeParse({ ...runtime, sandboxType }).success).toBe(
        false
      );
    }
  );

  it.each(['7.4.20', '2.4.0', '0.0.0-dev-20260902123456', '7.4.20-rc.1', '7.4.20-canary'])(
    'accepts a bounded version %s',
    version => {
      expect(safeSandboxRuntimeVersion(version)).toBe(version);
    }
  );

  it.each([
    '',
    '7.4',
    'private-instance',
    'https://runtime.invalid',
    'Bearer credential',
    '7.4.20+private-instance',
    '7.4.20-private-instance',
    '7.4.20\n',
    '7.4.20\r\n',
    ' 7.4.20',
    '1234567.1.1',
    '1.2.3-rc.123456789012345',
    '1'.repeat(128),
    null,
    undefined,
  ])('does not reflect unsafe or unsupported version %j', version => {
    expect(safeSandboxRuntimeVersion(version)).toBeNull();
    for (const field of ['kiloCliVersion', 'wrapperVersion']) {
      if (version === null) continue;
      expect(SandboxRuntimeMetadataSchema.safeParse({ ...runtime, [field]: version }).success).toBe(
        false
      );
    }
  });

  it.each(['startedAt', 'stoppedAt'])('validates lifecycle timestamp %s', field => {
    for (const invalid of [...invalidNumbers, 8_640_000_000_000_001]) {
      expect(SandboxRuntimeMetadataSchema.safeParse({ ...runtime, [field]: invalid }).success).toBe(
        false
      );
    }
  });

  it('strips private metadata fields without returning raw identifiers or errors', () => {
    const result = SandboxStatusSnapshotSchema.parse({
      ...snapshot,
      ...privateFields,
      runtime: { ...runtime, ...privateFields },
    });
    expect(result).toEqual({ ...snapshot, runtime });
    expect(JSON.stringify(result)).not.toContain('private');
  });
});

describe('getSandboxProviderLabel', () => {
  it.each([
    ['cloudflare', 'Cloudflare'],
    ['vercel', 'Vercel'],
  ])('maps the stored provider %s to %s', (provider, label) => {
    expect(getSandboxProviderLabel(provider)).toBe(label);
  });

  it.each([
    undefined,
    null,
    '',
    'private-provider',
    'Cloudflare',
    'vercel:private-instance',
    {},
    1,
  ])('does not reflect unknown provider data', provider => {
    expect(getSandboxProviderLabel(provider)).toBe('Unknown');
  });
});
