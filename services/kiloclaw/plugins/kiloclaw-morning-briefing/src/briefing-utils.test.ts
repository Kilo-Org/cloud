import { describe, expect, it } from 'vitest';
import {
  buildBriefingMarkdown,
  formatBriefingMarkdownForMessage,
  formatDateKey,
  offsetDateKey,
  resolveBriefingPath,
} from './briefing-utils';

describe('briefing-utils', () => {
  it('formats date keys as YYYY-MM-DD in configured timezone', () => {
    expect(formatDateKey(new Date('2026-04-23T03:30:00Z'), 'America/Los_Angeles')).toBe(
      '2026-04-22'
    );
  });

  it('resolves today/yesterday offsets in configured timezone', () => {
    const base = new Date('2026-04-23T12:00:00Z');
    expect(offsetDateKey(base, 0, 'America/New_York')).toBe('2026-04-23');
    expect(offsetDateKey(base, -1, 'America/New_York')).toBe('2026-04-22');
  });

  it('creates markdown with status and sections', () => {
    const markdown = buildBriefingMarkdown({
      dateKey: '2026-04-23',
      generatedAt: new Date('2026-04-23T07:00:01Z'),
      statuses: [
        { source: 'github', configured: true, ok: true, summary: 'Fetched 3 issues' },
        { source: 'linear', configured: true, ok: false, summary: 'Validation pending' },
        { source: 'web', configured: false, ok: false, summary: 'No search provider configured' },
      ],
      sections: [
        { title: 'GitHub', lines: ['- Item 1'] },
        { title: 'Linear', lines: [] },
      ],
      failures: ['Linear adapter validation pending'],
    });

    expect(markdown).toContain('# Morning Briefing - 2026-04-23');
    expect(markdown).toContain('## Source Status');
    expect(markdown).toContain('- github: [ok] Fetched 3 issues');
    expect(markdown).toContain('## GitHub');
    expect(markdown).toContain('- Item 1');
    expect(markdown).toContain('## Failures');
  });

  it('omits failures section when there are no failures', () => {
    const markdown = buildBriefingMarkdown({
      dateKey: '2026-04-23',
      generatedAt: new Date('2026-04-23T07:00:01Z'),
      statuses: [
        { source: 'github', configured: true, ok: true, summary: 'Fetched 1 issue' },
        { source: 'linear', configured: true, ok: true, summary: 'Fetched 1 issue' },
        { source: 'web', configured: true, ok: true, summary: 'Fetched 1 result' },
      ],
      sections: [{ title: 'GitHub', lines: ['- Item 1'] }],
      failures: [],
    });

    expect(markdown).not.toContain('## Failures');
  });

  it('builds date-based file paths', () => {
    const filePath = resolveBriefingPath('/tmp/briefings', '2026-04-23');
    expect(filePath.endsWith('/briefings/2026-04-23.md')).toBe(true);
  });

  it('adapts briefing markdown into channel-friendly text', () => {
    const markdown = [
      '# Morning Briefing - 2026-04-23',
      '',
      '## GitHub',
      '- [Fix flaky build](https://example.com/issue/1) (updated 2026-04-23)',
      '',
      '## Source Status',
      '- github: [ok] Fetched 1 open issue',
      '',
      '_Generated at 2026-04-23T07:00:01.000Z_',
    ].join('\n');

    const message = formatBriefingMarkdownForMessage(markdown);

    expect(message).toContain('Morning Briefing - 2026-04-23');
    expect(message).toContain('GitHub');
    expect(message).toContain(
      '• Fix flaky build - https://example.com/issue/1 (updated 2026-04-23)'
    );
    expect(message).toContain('Generated at 2026-04-23T07:00:01.000Z');
    expect(message).not.toContain('# ');
    expect(message).not.toContain('[');
  });

  it('keeps markdown links with nested parentheses intact when adapting for messages', () => {
    const markdown = [
      '# Morning Briefing - 2026-04-23',
      '',
      '## Web Search',
      '- [Spec page](https://example.com/wiki/Foo_(bar))',
      '- [Another page](https://example.com/docs/(deep)/(nested))',
    ].join('\n');

    const message = formatBriefingMarkdownForMessage(markdown);

    expect(message).toContain('• Spec page - https://example.com/wiki/Foo_(bar)');
    expect(message).toContain('• Another page - https://example.com/docs/(deep)/(nested)');
  });
});
