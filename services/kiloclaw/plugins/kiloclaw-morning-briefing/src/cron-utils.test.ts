import { describe, expect, it } from 'vitest';
import {
  filterEnabledBriefingJobs,
  pickCanonicalCronJobId,
  selectMorningBriefingJobs,
} from './cron-utils';

describe('cron-utils', () => {
  it('selects only briefing jobs with matching tool allowlist', () => {
    const jobs = selectMorningBriefingJobs(
      {
        jobs: [
          {
            id: 'a',
            name: 'KiloClaw Morning Briefing',
            enabled: true,
            payload: { toolsAllow: ['morning_briefing_generate'] },
          },
          {
            id: 'b',
            name: 'KiloClaw Morning Briefing',
            enabled: true,
            payload: { toolsAllow: ['something_else'] },
          },
        ],
      },
      'KiloClaw Morning Briefing',
      'morning_briefing_generate'
    );

    expect(jobs.map(job => job.id)).toEqual(['a']);
  });

  it('prefers configured id when present', () => {
    const canonical = pickCanonicalCronJobId(
      [
        { id: 'old', enabled: true, updatedAtMs: 1, createdAtMs: 1 },
        { id: 'new', enabled: true, updatedAtMs: 2, createdAtMs: 2 },
      ],
      'old'
    );

    expect(canonical).toBe('old');
  });

  it('otherwise picks latest updated job', () => {
    const canonical = pickCanonicalCronJobId(
      [
        { id: 'old', enabled: true, updatedAtMs: 1, createdAtMs: 1 },
        { id: 'new', enabled: true, updatedAtMs: 2, createdAtMs: 2 },
      ],
      null
    );

    expect(canonical).toBe('new');
  });

  it('filters only enabled briefing jobs', () => {
    const filtered = filterEnabledBriefingJobs([
      { id: 'enabled', enabled: true, updatedAtMs: 1, createdAtMs: 1 },
      { id: 'disabled', enabled: false, updatedAtMs: 1, createdAtMs: 1 },
    ]);

    expect(filtered.map(job => job.id)).toEqual(['enabled']);
  });
});
