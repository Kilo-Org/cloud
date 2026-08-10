import { describe, expect, it } from '@jest/globals';

import {
  applyDataExportFilters,
  parseDataExportFilters,
  parseEmailStatusFilter,
  parseHealthFilter,
  parsePage,
  parseSearch,
  parseStatusFilter,
} from './data-export-filters';

describe('parsePage', () => {
  it('defaults to 1 for missing or invalid values', () => {
    expect(parsePage(null)).toBe(1);
    expect(parsePage('')).toBe(1);
    expect(parsePage('abc')).toBe(1);
    expect(parsePage('0')).toBe(1);
    expect(parsePage('-3')).toBe(1);
    expect(parsePage('1.9')).toBe(1);
  });

  it('parses positive integers', () => {
    expect(parsePage('2')).toBe(2);
    expect(parsePage('25')).toBe(25);
  });
});

describe('parseHealthFilter', () => {
  it('defaults to needs_attention', () => {
    expect(parseHealthFilter(null)).toBe('needs_attention');
    expect(parseHealthFilter('bogus')).toBe('needs_attention');
  });

  it('accepts known health filters', () => {
    expect(parseHealthFilter('needs_attention')).toBe('needs_attention');
    expect(parseHealthFilter('active')).toBe('active');
    expect(parseHealthFilter('terminal')).toBe('terminal');
    expect(parseHealthFilter('all')).toBe('all');
  });
});

describe('parseStatusFilter', () => {
  it('returns undefined for missing or unknown values', () => {
    expect(parseStatusFilter(null)).toBeUndefined();
    expect(parseStatusFilter('bogus')).toBeUndefined();
  });

  it('accepts known statuses', () => {
    expect(parseStatusFilter('queued')).toBe('queued');
    expect(parseStatusFilter('processing')).toBe('processing');
    expect(parseStatusFilter('finalizing')).toBe('finalizing');
    expect(parseStatusFilter('ready')).toBe('ready');
    expect(parseStatusFilter('failed')).toBe('failed');
    expect(parseStatusFilter('expired')).toBe('expired');
  });
});

describe('parseEmailStatusFilter', () => {
  it('returns undefined for missing or unknown values', () => {
    expect(parseEmailStatusFilter(null)).toBeUndefined();
    expect(parseEmailStatusFilter('bogus')).toBeUndefined();
  });

  it('accepts known email statuses', () => {
    expect(parseEmailStatusFilter('pending')).toBe('pending');
    expect(parseEmailStatusFilter('sending')).toBe('sending');
    expect(parseEmailStatusFilter('sent')).toBe('sent');
    expect(parseEmailStatusFilter('failed')).toBe('failed');
  });
});

describe('parseSearch', () => {
  it('returns undefined for empty input', () => {
    expect(parseSearch(null)).toBeUndefined();
    expect(parseSearch('')).toBeUndefined();
    expect(parseSearch('   ')).toBeUndefined();
  });

  it('trims input and caps length at 320 characters', () => {
    expect(parseSearch('  user@example.com  ')).toBe('user@example.com');
    expect(parseSearch('x'.repeat(400))).toHaveLength(320);
  });
});

describe('parseDataExportFilters', () => {
  it('parses a full param set', () => {
    const filters = parseDataExportFilters(
      new URLSearchParams('health=active&status=failed&email=sent&q=abc&page=3')
    );
    expect(filters).toEqual({
      health: 'active',
      status: 'failed',
      emailStatus: 'sent',
      search: 'abc',
      page: 3,
    });
  });

  it('falls back to safe defaults for an empty param set', () => {
    expect(parseDataExportFilters(new URLSearchParams())).toEqual({
      health: 'needs_attention',
      status: undefined,
      emailStatus: undefined,
      search: undefined,
      page: 1,
    });
  });
});

describe('applyDataExportFilters', () => {
  it('omits default values from the URL', () => {
    const params = applyDataExportFilters(new URLSearchParams(), {
      health: 'needs_attention',
      status: undefined,
      emailStatus: undefined,
      search: undefined,
      page: 1,
    });
    expect(params.toString()).toBe('');
  });

  it('sets non-default values and removes stale keys', () => {
    const params = applyDataExportFilters(new URLSearchParams('health=all&page=4&q=old'), {
      health: 'all',
      status: 'ready',
      emailStatus: 'failed',
      search: undefined,
      page: 2,
    });
    expect(params.get('health')).toBe('all');
    expect(params.get('status')).toBe('ready');
    expect(params.get('email')).toBe('failed');
    expect(params.get('page')).toBe('2');
    expect(params.get('q')).toBeNull();
  });

  it('preserves unrelated params', () => {
    const params = applyDataExportFilters(new URLSearchParams('tab=other'), {
      health: 'needs_attention',
      status: undefined,
      emailStatus: undefined,
      search: 'user@example.com',
      page: 1,
    });
    expect(params.get('tab')).toBe('other');
    expect(params.get('q')).toBe('user@example.com');
  });
});
