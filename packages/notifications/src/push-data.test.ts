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
