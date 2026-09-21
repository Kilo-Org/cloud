import { describe, expect, it } from 'vitest';

import { pushDataSchema } from './push-data';

const lifecycleEvents = [
  'analysis_completed',
  'analysis_failed',
  'remediation_queued',
  'remediation_pr_opened',
  'remediation_failed',
  'remediation_blocked',
  'remediation_no_changes_needed',
  'remediation_cancelled',
] as const;

describe('pushDataSchema security_lifecycle', () => {
  it('parses a round-trip for every event value', () => {
    for (const event of lifecycleEvents) {
      const payload = {
        type: 'security_lifecycle',
        event,
        findingId: 'finding-1',
        scope: 'org',
      };
      const parsed = pushDataSchema.parse(payload);
      expect(parsed).toEqual(payload);
    }
  });

  it('parses the optional remediationId and prUrl fields', () => {
    const payload = {
      type: 'security_lifecycle',
      event: 'remediation_pr_opened',
      findingId: 'finding-1',
      scope: 'org',
      remediationId: 'remediation-1',
      prUrl: 'https://github.com/org/repo/pull/1',
    };
    expect(pushDataSchema.parse(payload)).toEqual(payload);
  });

  it('rejects an unknown event value', () => {
    const payload = {
      type: 'security_lifecycle',
      event: 'sla_warning',
      findingId: 'finding-1',
      scope: 'org',
    };
    expect(pushDataSchema.safeParse(payload).success).toBe(false);
  });

  it('rejects an empty findingId or scope', () => {
    expect(
      pushDataSchema.safeParse({
        type: 'security_lifecycle',
        event: 'analysis_completed',
        findingId: '',
        scope: 'org',
      }).success
    ).toBe(false);
    expect(
      pushDataSchema.safeParse({
        type: 'security_lifecycle',
        event: 'analysis_completed',
        findingId: 'finding-1',
        scope: '',
      }).success
    ).toBe(false);
  });
});

describe('pushDataSchema cloud_agent_session', () => {
  it('parses the optional attentionKind and prUrl of a needs-input raise', () => {
    const payload = {
      type: 'cloud_agent_session',
      cliSessionId: 'cli1',
      category: 'attention',
      attentionKind: 'question',
      prUrl: 'https://github.com/org/repo/pull/1',
    };
    expect(pushDataSchema.parse(payload)).toEqual(payload);
  });

  it('parses a permission raise without a PR and a status push without either field', () => {
    const permission = {
      type: 'cloud_agent_session',
      cliSessionId: 'cli1',
      category: 'attention',
      attentionKind: 'permission',
    };
    expect(pushDataSchema.parse(permission)).toEqual(permission);

    const status = { type: 'cloud_agent_session', cliSessionId: 'cli1', category: 'status' };
    expect(pushDataSchema.parse(status)).toEqual(status);
  });

  it('rejects an attentionKind outside question/permission', () => {
    const payload = {
      type: 'cloud_agent_session',
      cliSessionId: 'cli1',
      category: 'attention',
      attentionKind: 'unknown',
    };
    expect(pushDataSchema.safeParse(payload).success).toBe(false);
  });

  it('rejects a non-string prUrl', () => {
    const payload = {
      type: 'cloud_agent_session',
      cliSessionId: 'cli1',
      category: 'attention',
      prUrl: 42,
    };
    expect(pushDataSchema.safeParse(payload).success).toBe(false);
  });
});

describe('pushDataSchema unknown type', () => {
  it('fails to parse an unknown type, proving old-client drop behavior', () => {
    const payload = {
      type: 'security_lifecycle_v2',
      event: 'analysis_completed',
      findingId: 'finding-1',
      scope: 'org',
    };
    expect(pushDataSchema.safeParse(payload).success).toBe(false);
  });
});

const glanceablePayload = {
  type: 'active_agents_glanceable',
  schemaVersion: 1,
  revision: 2,
  scopeKey: 'deadbeef',
  organizationBound: false,
  status: 'happy',
  running: 1,
  needsInput: 2,
  idle: 0,
  updatedAt: '2026-08-27T10:00:00.000Z',
  expiresAt: '2026-08-27T18:00:00.000Z',
  needsInputSince: '2026-08-27T09:00:00.000Z',
} as const;

describe('pushDataSchema active_agents_glanceable', () => {
  it('parses a payload whose server omits needsApproval without inventing a value', () => {
    const parsed = pushDataSchema.parse(glanceablePayload);
    expect(parsed).toEqual(glanceablePayload);
    // Optional on the wire so a push from an older server still parses; the
    // mobile readers treat absent as zero.
    expect('needsApproval' in parsed).toBe(false);
  });

  it('parses a payload carrying needsApproval', () => {
    const payload = { ...glanceablePayload, needsApproval: 2 };
    expect(pushDataSchema.parse(payload)).toEqual(payload);
  });

  it('rejects a negative or fractional needsApproval', () => {
    expect(pushDataSchema.safeParse({ ...glanceablePayload, needsApproval: -1 }).success).toBe(
      false
    );
    expect(pushDataSchema.safeParse({ ...glanceablePayload, needsApproval: 1.5 }).success).toBe(
      false
    );
  });
});
