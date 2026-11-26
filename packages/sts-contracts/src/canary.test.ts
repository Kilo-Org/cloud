import { describe, expect, it } from 'vitest';
import {
  STS_CANARY_DETAIL_MAX,
  STS_DENIED_PROBE_APL_EXCLUSION,
  StsCanaryCheckSchema,
  StsCanaryReportSchema,
  isStsDeniedProbe,
  stsCanaryDetail,
  stsCanaryPassed,
  type StsCanaryReport,
} from './canary';

const PASSING: StsCanaryReport = {
  inbound: 'ok',
  outbound: { result: 'ok', status: 204 },
  negatives: {
    wrongAudience: { result: 'ok', status: 403 },
    forged: { result: 'ok', status: 401 },
    expired: 'skipped',
    stsDenied: { result: 'ok', status: null },
  },
};

describe('STS canary check detail', () => {
  it('refuses a detail past the cap and truncates text to it', () => {
    const long = 'x'.repeat(STS_CANARY_DETAIL_MAX + 1);
    expect(
      StsCanaryCheckSchema.safeParse({ result: 'failed', status: null, detail: long }).success
    ).toBe(false);
    const detail = stsCanaryDetail(long);
    expect(detail).toHaveLength(STS_CANARY_DETAIL_MAX);
    expect(StsCanaryCheckSchema.safeParse({ result: 'failed', status: null, detail }).success).toBe(
      true
    );
    expect(stsCanaryDetail('expected 204')).toBe('expected 204');
  });
});

describe('STS canary report', () => {
  it('needs the denied mint on every run and passes only when STS refused it', () => {
    expect(stsCanaryPassed(PASSING)).toBe(true);
    const failed: StsCanaryReport = {
      ...PASSING,
      negatives: {
        ...PASSING.negatives,
        stsDenied: { result: 'failed', status: null, detail: 'mint unavailable: retry in 10 s' },
      },
    };
    expect(stsCanaryPassed(failed)).toBe(false);

    const { wrongAudience, forged, expired } = PASSING.negatives;
    expect(
      StsCanaryReportSchema.safeParse({ ...PASSING, negatives: { wrongAudience, forged, expired } })
        .success
    ).toBe(false);
    expect(
      StsCanaryReportSchema.safeParse({
        ...PASSING,
        negatives: { ...PASSING.negatives, stsDenied: 'skipped' },
      }).success
    ).toBe(false);
  });
});

describe('STS denied-probe exclusion', () => {
  /** `token.denied` attributes as STS writes them (`tokenDeniedEvent` in services/sts). */
  const denial = (workload: string, audience?: string, scope?: string) => ({
    environment: 'production',
    channel: 'http',
    reason: 'audience_not_allowed',
    workload,
    ...(audience === undefined ? {} : { audience }),
    ...(scope === undefined ? {} : { scope }),
    count: 1,
  });

  it('drops only the web probe row and keeps every other denial', () => {
    const rows = [
      denial('web', 'canary', 'canary:denied-probe'),
      // The same caller refused another scope: a real denial.
      denial('web', 'gateway', 'gateway:models.read'),
      denial('web', 'web', 'web:sts.canary'),
      // The probe scope asked for by another workload: a real denial.
      denial('usage-ingest', 'canary', 'canary:denied-probe'),
      // A whole-call refusal names no audience or scope.
      denial('web'),
    ];
    expect(rows.filter(row => !isStsDeniedProbe(row))).toEqual(rows.slice(1));
  });

  it('states the same exclusion as one APL line', () => {
    expect(STS_DENIED_PROBE_APL_EXCLUSION).toBe(
      "| where not(tostring(column_ifexists('data.attributes.workload', '')) == 'web' and tostring(column_ifexists('data.attributes.scope', '')) == 'canary:denied-probe')"
    );
  });
});
