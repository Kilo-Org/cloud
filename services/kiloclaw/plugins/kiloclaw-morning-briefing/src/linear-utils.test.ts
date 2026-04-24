import { describe, expect, it } from 'vitest';
import { normalizeLinearIssues, summarizeLinearCallFailure } from './linear-utils';

describe('linear-utils', () => {
  it('normalizes list_issues payload into concise issue summaries', () => {
    const issues = normalizeLinearIssues({
      issues: [
        {
          id: 'TES-1',
          title: 'Get familiar with Linear',
          status: 'Todo',
          url: 'https://linear.app/example/issue/TES-1',
          updatedAt: '2026-04-23T22:28:59.657Z',
        },
      ],
    });

    expect(issues).toEqual([
      {
        id: 'TES-1',
        title: 'Get familiar with Linear',
        status: 'Todo',
        url: 'https://linear.app/example/issue/TES-1',
        updatedAt: '2026-04-23T22:28:59.657Z',
      },
    ]);
  });

  it('summarizes auth errors from mcporter JSON payloads', () => {
    const summary = summarizeLinearCallFailure(
      JSON.stringify({
        server: 'linear',
        tool: 'list_issues',
        error: 'SSE error: Non-200 status code (401)',
        issue: { kind: 'auth', statusCode: 401 },
      }),
      ''
    );

    expect(summary).toBe('Linear authentication failed (check LINEAR_API_KEY and redeploy)');
  });

  it('falls back to combined stderr/stdout for non-JSON errors', () => {
    const summary = summarizeLinearCallFailure('', 'mcporter: Unknown tool list_issues_typo');
    expect(summary).toContain('Unknown tool');
  });
});
