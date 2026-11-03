import { parseSecurityAgentConfig } from './constants';
import {
  ListFindingsInputSchema,
  SaveSecurityConfigInputSchema,
  SetEnabledInputSchema,
} from './schemas';

const SLA_FIELDS = ['slaCriticalDays', 'slaHighDays', 'slaMediumDays', 'slaLowDays'] as const;

const STORED_SLA_FIELDS = {
  slaCriticalDays: 'sla_critical_days',
  slaHighDays: 'sla_high_days',
  slaMediumDays: 'sla_medium_days',
  slaLowDays: 'sla_low_days',
} as const;

describe('SaveSecurityConfigInputSchema SLA days', () => {
  it.each(SLA_FIELDS)('rejects a fractional %s with the field path', field => {
    const parsed = SaveSecurityConfigInputSchema.safeParse({ expectedRevision: 1, [field]: 1.5 });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map(issue => issue.path)).toEqual([[field]]);
  });

  it('accepts whole days at both bounds', () => {
    const parsed = SaveSecurityConfigInputSchema.safeParse({
      expectedRevision: 1,
      slaCriticalDays: 1,
      slaHighDays: 365,
      slaMediumDays: 45,
      slaLowDays: 90,
    });

    expect(parsed.success).toBe(true);
  });

  it('keeps every SLA day optional', () => {
    const parsed = SaveSecurityConfigInputSchema.safeParse({ expectedRevision: null });

    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ expectedRevision: null });
  });

  it.each(SLA_FIELDS)('refuses the fractional %s before config parsing sees it', field => {
    const parsed = SaveSecurityConfigInputSchema.safeParse({ expectedRevision: 1, [field]: 1.5 });

    expect(parsed.success).toBe(false);
    // The stored config schema refuses the same value, so an input that passes
    // here but fails there would surface as an internal error instead of a
    // field-level validation error.
    expect(() => parseSecurityAgentConfig({ [STORED_SLA_FIELDS[field]]: 1.5 })).toThrow();
  });

  it('accepts every whole day value the stored config schema accepts', () => {
    const parsed = SaveSecurityConfigInputSchema.safeParse({
      expectedRevision: 1,
      slaLowDays: 365,
    });

    expect(parsed.success).toBe(true);
    expect(parseSecurityAgentConfig({ sla_low_days: 365 }).sla_low_days).toBe(365);
  });
});

describe('SaveSecurityConfigInputSchema repository selection', () => {
  it('rejects a fractional selected repository id', () => {
    const parsed = SaveSecurityConfigInputSchema.safeParse({
      expectedRevision: 1,
      selectedRepositoryIds: [1, 2.5],
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map(issue => issue.path)).toEqual([['selectedRepositoryIds', 1]]);
  });

  it('accepts whole repository ids', () => {
    const parsed = SaveSecurityConfigInputSchema.safeParse({
      expectedRevision: 1,
      selectedRepositoryIds: [1, 42],
    });

    expect(parsed.success).toBe(true);
  });
});

describe('SetEnabledInputSchema repository selection', () => {
  it('rejects a fractional selected repository id', () => {
    const parsed = SetEnabledInputSchema.safeParse({
      isEnabled: true,
      selectedRepositoryIds: [3.5],
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map(issue => issue.path)).toEqual([['selectedRepositoryIds', 0]]);
  });

  it('accepts whole repository ids', () => {
    const parsed = SetEnabledInputSchema.safeParse({
      isEnabled: true,
      selectedRepositoryIds: [3],
    });

    expect(parsed.success).toBe(true);
  });
});

describe('ListFindingsInputSchema page window', () => {
  it('rejects a fractional limit with the field path', () => {
    const parsed = ListFindingsInputSchema.safeParse({ limit: 50.5 });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map(issue => issue.path)).toEqual([['limit']]);
  });

  it('rejects a fractional offset with the field path', () => {
    const parsed = ListFindingsInputSchema.safeParse({ offset: 10.5 });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map(issue => issue.path)).toEqual([['offset']]);
  });

  it('defaults limit and offset when the window is omitted', () => {
    const parsed = ListFindingsInputSchema.safeParse({});

    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ limit: 50, offset: 0 });
  });

  it('accepts whole page bounds at both ends', () => {
    const first = ListFindingsInputSchema.safeParse({ limit: 1, offset: 0 });
    const last = ListFindingsInputSchema.safeParse({ limit: 100, offset: 1000 });

    expect(first.success).toBe(true);
    expect(first.data).toMatchObject({ limit: 1, offset: 0 });
    expect(last.success).toBe(true);
    expect(last.data).toMatchObject({ limit: 100, offset: 1000 });
  });

  it('still rejects out-of-range page bounds', () => {
    expect(ListFindingsInputSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(ListFindingsInputSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(ListFindingsInputSchema.safeParse({ offset: -1 }).success).toBe(false);
  });
});
