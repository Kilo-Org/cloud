import { describe, it, expect } from 'vitest';
import { SubmissionSchema } from '../src/routes/api';

/**
 * SubmissionSchema is the wire contract between the bench service and
 * cloud's ingest worker. These tests pin down every edge case the
 * validator must catch — if any of them regress, we could silently
 * accept garbage data onto a model's public leaderboard entry.
 */

function validSubmission(overrides: Partial<Record<string, unknown>> = {}): unknown {
  return {
    bench_job_name: 'kilo__sonnet-4.6__terminal-bench__2026-05-01',
    bench_job_url: 'https://bench.s1lv.com/jobs/kilo__sonnet-4.6__terminal-bench__2026-05-01',
    provider: 'anthropic',
    model: 'claude-sonnet-4.6',
    variant: null,
    task_source: 'terminal-bench',
    aggregate: {
      n_trials: 89,
      success_rate: 0.483,
      avg_cost_usd: 0.072,
      avg_input_tokens: 52341,
      avg_output_tokens: 2876,
      avg_cache_read_tokens: 40122,
      avg_execution_ms: 18500,
    },
    review_note: 'Clean terminal-bench run, all trials completed',
    promoted_by_email: 'alice@kilocode.ai',
    ...overrides,
  };
}

describe('SubmissionSchema', () => {
  it('accepts a realistic valid payload', () => {
    expect(() => SubmissionSchema.parse(validSubmission())).not.toThrow();
  });

  it('accepts a variant string', () => {
    const parsed = SubmissionSchema.parse(validSubmission({ variant: 'high' }));
    expect(parsed.variant).toBe('high');
  });

  it('accepts optional task_source_display_name', () => {
    const parsed = SubmissionSchema.parse(
      validSubmission({ task_source_display_name: 'Terminal-Bench' })
    );
    expect(parsed.task_source_display_name).toBe('Terminal-Bench');
  });

  it('accepts null review_note', () => {
    const parsed = SubmissionSchema.parse(validSubmission({ review_note: null }));
    expect(parsed.review_note).toBeNull();
  });

  it('rejects missing required top-level fields', () => {
    expect(() => SubmissionSchema.parse(validSubmission({ provider: undefined }))).toThrow();
    expect(() => SubmissionSchema.parse(validSubmission({ model: undefined }))).toThrow();
    expect(() => SubmissionSchema.parse(validSubmission({ task_source: undefined }))).toThrow();
  });

  it('rejects invalid bench_job_url', () => {
    expect(() => SubmissionSchema.parse(validSubmission({ bench_job_url: 'not-a-url' }))).toThrow();
  });

  it('rejects invalid promoted_by_email', () => {
    expect(() =>
      SubmissionSchema.parse(validSubmission({ promoted_by_email: 'not-an-email' }))
    ).toThrow();
  });

  it('rejects n_trials of zero (promoting an empty run makes no sense)', () => {
    expect(() =>
      SubmissionSchema.parse({
        ...(validSubmission() as object),
        aggregate: {
          ...(validSubmission() as { aggregate: object }).aggregate,
          n_trials: 0,
        },
      })
    ).toThrow();
  });

  it('rejects negative success_rate', () => {
    expect(() =>
      SubmissionSchema.parse({
        ...(validSubmission() as object),
        aggregate: {
          ...(validSubmission() as { aggregate: object }).aggregate,
          success_rate: -0.1,
        },
      })
    ).toThrow();
  });

  it('rejects absurdly high success_rate (> 10)', () => {
    expect(() =>
      SubmissionSchema.parse({
        ...(validSubmission() as object),
        aggregate: {
          ...(validSubmission() as { aggregate: object }).aggregate,
          success_rate: 42,
        },
      })
    ).toThrow();
  });

  it('rejects negative cost', () => {
    expect(() =>
      SubmissionSchema.parse({
        ...(validSubmission() as object),
        aggregate: {
          ...(validSubmission() as { aggregate: object }).aggregate,
          avg_cost_usd: -1,
        },
      })
    ).toThrow();
  });

  it('rejects float n_trials', () => {
    expect(() =>
      SubmissionSchema.parse({
        ...(validSubmission() as object),
        aggregate: {
          ...(validSubmission() as { aggregate: object }).aggregate,
          n_trials: 1.5,
        },
      })
    ).toThrow();
  });

  it('rejects float token counts', () => {
    expect(() =>
      SubmissionSchema.parse({
        ...(validSubmission() as object),
        aggregate: {
          ...(validSubmission() as { aggregate: object }).aggregate,
          avg_input_tokens: 1.5,
        },
      })
    ).toThrow();
  });

  it('accepts zero for token counts (model with free/zero-priced tier)', () => {
    expect(() =>
      SubmissionSchema.parse({
        ...(validSubmission() as object),
        aggregate: {
          ...(validSubmission() as { aggregate: object }).aggregate,
          avg_cost_usd: 0,
          avg_cache_read_tokens: 0,
        },
      })
    ).not.toThrow();
  });
});
