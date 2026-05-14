import { describe, expect, it } from 'vitest';
import {
  formatLinearIssueLine,
  hasHighSignalPriority,
  type LinearIssueSummary,
  normalizeLinearIssues,
  shouldShowPriorityBadge,
  summarizeLinearCallFailure,
} from './linear-utils';

function buildIssue(overrides: Partial<LinearIssueSummary> = {}): LinearIssueSummary {
  const id = overrides.id ?? 'KIL-1';
  return {
    id,
    title: 'Sample',
    status: 'Todo',
    url: `https://linear.app/x/issue/${id}`,
    labels: [],
    ...overrides,
  };
}

describe('normalizeLinearIssues', () => {
  it('extracts priority, labels, and dueDate when present', () => {
    const issues = normalizeLinearIssues({
      issues: [
        {
          id: 'KIL-8',
          title: 'My test issue',
          status: 'Todo',
          url: 'https://linear.app/x/issue/KIL-8',
          updatedAt: '2026-05-14T23:13:00.450Z',
          priority: { value: 1, name: 'Urgent' },
          labels: ['Bug'],
          dueDate: '2026-05-15',
        },
      ],
    });

    expect(issues).toEqual([
      {
        id: 'KIL-8',
        title: 'My test issue',
        status: 'Todo',
        url: 'https://linear.app/x/issue/KIL-8',
        updatedAt: '2026-05-14T23:13:00.450Z',
        priority: { value: 1, name: 'Urgent' },
        labels: ['Bug'],
        dueDate: '2026-05-15',
      },
    ]);
  });

  it('defaults priority to undefined and labels to empty array when missing', () => {
    const [issue] = normalizeLinearIssues({
      issues: [
        {
          id: 'KIL-1',
          title: 'Plain',
          status: 'Todo',
          url: 'https://linear.app/x/issue/KIL-1',
        },
      ],
    });

    expect(issue.priority).toBeUndefined();
    expect(issue.labels).toEqual([]);
    expect(issue.dueDate).toBeUndefined();
  });

  it('rejects dueDate values that are not YYYY-MM-DD', () => {
    const [issue] = normalizeLinearIssues({
      issues: [
        {
          id: 'KIL-9',
          title: 'Bad date',
          status: 'Todo',
          url: 'https://linear.app/x/issue/KIL-9',
          dueDate: '2026/05/15',
        },
      ],
    });
    expect(issue.dueDate).toBeUndefined();
  });

  it('rejects an empty-string dueDate', () => {
    const [issue] = normalizeLinearIssues({
      issues: [
        {
          id: 'KIL-10',
          title: 'Empty date',
          status: 'Todo',
          url: 'https://linear.app/x/issue/KIL-10',
          dueDate: '',
        },
      ],
    });
    expect(issue.dueDate).toBeUndefined();
  });

  it('drops malformed labels and priority entries', () => {
    const [issue] = normalizeLinearIssues({
      issues: [
        {
          id: 'KIL-2',
          title: 'Mixed',
          status: 'Todo',
          url: 'https://linear.app/x/issue/KIL-2',
          priority: { value: 'not a number', name: 'High' },
          labels: ['Real', '', 42, '  ', 'AlsoReal'],
        },
      ],
    });

    expect(issue.priority).toBeUndefined();
    expect(issue.labels).toEqual(['Real', 'AlsoReal']);
  });
});

describe('hasHighSignalPriority', () => {
  it('returns true when at least one issue is Urgent / High / Medium', () => {
    expect(hasHighSignalPriority([buildIssue({ priority: { value: 3, name: 'Medium' } })])).toBe(
      true
    );
  });

  it('returns false when only Low / None / no-priority issues exist', () => {
    expect(
      hasHighSignalPriority([
        buildIssue({ priority: { value: 4, name: 'Low' } }),
        buildIssue({ priority: { value: 0, name: 'None' } }),
        buildIssue(),
      ])
    ).toBe(false);
  });

  it('returns false on an empty list', () => {
    expect(hasHighSignalPriority([])).toBe(false);
  });
});

describe('shouldShowPriorityBadge', () => {
  it('always shows badge for Urgent / High / Medium', () => {
    for (const value of [1, 2, 3]) {
      const issue = buildIssue({ priority: { value, name: 'X' } });
      expect(shouldShowPriorityBadge(issue, false)).toBe(true);
      expect(shouldShowPriorityBadge(issue, true)).toBe(true);
    }
  });

  it('shows Low / None only when no high signal exists in the brief', () => {
    for (const value of [4, 0]) {
      const issue = buildIssue({ priority: { value, name: 'X' } });
      expect(shouldShowPriorityBadge(issue, false)).toBe(true);
      expect(shouldShowPriorityBadge(issue, true)).toBe(false);
    }
  });

  it('never shows badge when priority is missing', () => {
    expect(shouldShowPriorityBadge(buildIssue(), false)).toBe(false);
    expect(shouldShowPriorityBadge(buildIssue(), true)).toBe(false);
  });
});

describe('formatLinearIssueLine', () => {
  it('renders priority and labels in a single bracket when present', () => {
    const line = formatLinearIssueLine(
      buildIssue({
        id: 'KIL-8',
        title: 'My test issue',
        url: 'https://linear.app/x/issue/KIL-8',
        priority: { value: 1, name: 'Urgent' },
        labels: ['Bug'],
        dueDate: '2026-05-15',
        updatedAt: '2026-05-14',
      }),
      true
    );

    expect(line).toBe(
      '- [KIL-8](https://linear.app/x/issue/KIL-8) [Urgent, Bug] My test issue - Todo (due 2026-05-15, updated 2026-05-14)'
    );
  });

  it('omits the bracket when there is no badge content', () => {
    const line = formatLinearIssueLine(
      buildIssue({ id: 'KIL-1', title: 'Plain', updatedAt: '2026-05-14' }),
      true
    );
    expect(line).toBe(
      '- [KIL-1](https://linear.app/x/issue/KIL-1) Plain - Todo (updated 2026-05-14)'
    );
  });

  it('hides Low / None priority when brief has high signal', () => {
    const line = formatLinearIssueLine(
      buildIssue({ id: 'KIL-2', priority: { value: 4, name: 'Low' }, labels: ['Backend'] }),
      true
    );
    expect(line).toContain('[Backend]');
    expect(line).not.toContain('Low');
  });

  it('shows Low / None priority when brief has no high signal', () => {
    const line = formatLinearIssueLine(
      buildIssue({ id: 'KIL-2', priority: { value: 4, name: 'Low' }, labels: ['Backend'] }),
      false
    );
    expect(line).toContain('[Low, Backend]');
  });

  it('renders labels comma-separated', () => {
    const line = formatLinearIssueLine(
      buildIssue({ labels: ['Bug', 'Frontend', 'Performance'] }),
      true
    );
    expect(line).toContain('[Bug, Frontend, Performance]');
  });

  it('drops the parens entirely when due date and updated are both missing', () => {
    const line = formatLinearIssueLine(buildIssue({ id: 'KIL-3', title: 'Bare' }), true);
    expect(line).toBe('- [KIL-3](https://linear.app/x/issue/KIL-3) Bare - Todo');
  });

  it('shows due date alone when updated is missing', () => {
    const line = formatLinearIssueLine(buildIssue({ dueDate: '2026-05-15' }), true);
    expect(line).toContain('(due 2026-05-15)');
    expect(line).not.toContain('updated');
  });

  it('trims a full ISO updatedAt timestamp down to YYYY-MM-DD', () => {
    const line = formatLinearIssueLine(buildIssue({ updatedAt: '2026-05-14T23:13:00.450Z' }), true);
    expect(line).toContain('updated 2026-05-14');
    expect(line).not.toContain('T23:13:00');
  });
});

describe('summarizeLinearCallFailure', () => {
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
