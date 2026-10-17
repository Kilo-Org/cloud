import { describe, it, expect } from 'vitest';
import { RigRecord } from './rigs';

describe('RigRecord stored config parsing', () => {
  it('loads a stored config with an above-ceiling limit field without throwing, keeping other fields', () => {
    const stored = JSON.stringify({
      default_model: 'openai/gpt-4o',
      max_concurrent_polecats: 100000,
    });
    const row = {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'rig-a',
      git_url: 'https://example.test/repo.git',
      default_branch: 'main',
      config: stored,
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const parsed = RigRecord.parse(row);
    expect(parsed.config.default_model).toBe('openai/gpt-4o');
    // The out-of-range limit is dropped, so dispatch falls back to town config
    expect(parsed.config.max_concurrent_polecats).toBeUndefined();
  });

  it('keeps an in-range limit field on a stored config', () => {
    const row = {
      id: '00000000-0000-4000-8000-000000000002',
      name: 'rig-b',
      git_url: '',
      default_branch: 'main',
      config: JSON.stringify({ max_dispatch_attempts: 7 }),
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const parsed = RigRecord.parse(row);
    expect(parsed.config.max_dispatch_attempts).toBe(7);
  });

  it('parses a malformed stored config to an empty override', () => {
    const row = {
      id: '00000000-0000-4000-8000-000000000003',
      name: 'rig-c',
      git_url: '',
      default_branch: 'main',
      config: 'not-json',
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const parsed = RigRecord.parse(row);
    expect(parsed.config).toEqual({});
  });

  it('loads an empty stored config to an empty override', () => {
    const row = {
      id: '00000000-0000-4000-8000-000000000004',
      name: 'rig-d',
      git_url: '',
      default_branch: 'main',
      config: '{}',
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const parsed = RigRecord.parse(row);
    expect(parsed.config).toEqual({});
  });
});
