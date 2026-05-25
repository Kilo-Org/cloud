import type { CodeReviewAgentConfig } from '@/lib/agent-config/core/types';
import { resolveTemplate, generateReviewPrompt } from './generate-prompt';
import type { PromptTemplate, ExistingReviewState } from './generate-prompt';
import {
  REVIEW_INSTRUCTIONS_FILE,
  normalizeRepositoryReviewInstructions,
} from './repository-review-instructions';

// --- Fixtures ---

const localTemplate = {
  version: 'local-v1',
  systemRole: 'local system role',
  hardConstraints: 'local constraints',
  workflow: 'local workflow',
  whatToReview: 'local what',
  commentFormat: 'local comment format',
  summaryFormatIssuesFound: 'local issues',
  summaryFormatNoIssues: 'local no issues',
  summaryMarkerNote: 'local marker',
  summaryCommandCreate: 'local create',
  summaryCommandUpdate: 'local update',
  inlineCommentsApi: 'local api',
  fixLinkTemplate: 'local fix',
  styleGuidance: { roast: 'ROAST MODE ACTIVATED', balanced: 'local balanced guidance' },
  commentFormatOverrides: { roast: 'roast comment format' },
  summaryFormatOverrides: { roast: { issuesFound: 'roast issues', noIssues: 'roast no issues' } },
} satisfies PromptTemplate;

const remoteTemplateWithoutStyleOverrides = {
  version: 'remote-v1',
  systemRole: 'remote system role',
  hardConstraints: 'remote constraints',
  workflow: 'remote workflow',
  whatToReview: 'remote what',
  commentFormat: 'remote comment format',
  summaryFormatIssuesFound: 'remote issues',
  summaryFormatNoIssues: 'remote no issues',
  summaryMarkerNote: 'remote marker',
  summaryCommandCreate: 'remote create',
  summaryCommandUpdate: 'remote update',
  inlineCommentsApi: 'remote api',
  fixLinkTemplate: 'remote fix',
} satisfies PromptTemplate;

const remoteTemplateWithNewStyleKey = {
  ...remoteTemplateWithoutStyleOverrides,
  styleGuidance: { strict: 'REMOTE STRICT GUIDANCE' },
  commentFormatOverrides: { strict: 'remote strict comment format' },
  summaryFormatOverrides: {
    strict: { issuesFound: 'remote strict issues', noIssues: 'remote strict no issues' },
  },
} satisfies PromptTemplate;

const remoteTemplateOverridingRoast = {
  ...remoteTemplateWithoutStyleOverrides,
  styleGuidance: { roast: 'REMOTE ROAST GUIDANCE' },
} satisfies PromptTemplate;

const remoteTemplateOverridingBalanced = {
  ...remoteTemplateWithoutStyleOverrides,
  styleGuidance: { balanced: 'REMOTE BALANCED GUIDANCE' },
} satisfies PromptTemplate;

// --- resolveTemplate ---

describe('resolveTemplate', () => {
  it('returns local template with source "local" when remote is undefined', () => {
    const result = resolveTemplate(undefined, localTemplate);

    expect(result.template).toBe(localTemplate);
    expect(result.source).toBe('local');
  });

  it('falls back to local style overrides when remote omits them', () => {
    const result = resolveTemplate(remoteTemplateWithoutStyleOverrides, localTemplate);

    expect(result.template.version).toBe('remote-v1');
    expect(result.template.systemRole).toBe('remote system role');
    expect(result.template.styleGuidance).toEqual({
      roast: 'ROAST MODE ACTIVATED',
      balanced: 'local balanced guidance',
    });
    expect(result.template.commentFormatOverrides).toEqual({ roast: 'roast comment format' });
    expect(result.template.summaryFormatOverrides).toEqual({
      roast: { issuesFound: 'roast issues', noIssues: 'roast no issues' },
    });
  });

  it('remote wins for keys that both local and remote define', () => {
    const result = resolveTemplate(remoteTemplateOverridingRoast, localTemplate);

    expect(result.template.styleGuidance?.['roast']).toBe('REMOTE ROAST GUIDANCE');
    // local-only keys still present
    expect(result.template.styleGuidance?.['balanced']).toBe('local balanced guidance');
  });

  it('remote wins for balanced key that local also defines', () => {
    const result = resolveTemplate(remoteTemplateOverridingBalanced, localTemplate);

    expect(result.template.styleGuidance?.['balanced']).toBe('REMOTE BALANCED GUIDANCE');
    // local-only keys still present
    expect(result.template.styleGuidance?.['roast']).toBe('ROAST MODE ACTIVATED');
  });

  it('merges remote style keys that local does not define', () => {
    const result = resolveTemplate(remoteTemplateWithNewStyleKey, localTemplate);

    expect(result.template.styleGuidance).toEqual({
      roast: 'ROAST MODE ACTIVATED',
      balanced: 'local balanced guidance',
      strict: 'REMOTE STRICT GUIDANCE',
    });
    expect(result.template.commentFormatOverrides).toEqual({
      roast: 'roast comment format',
      strict: 'remote strict comment format',
    });
    expect(result.template.summaryFormatOverrides).toEqual({
      roast: { issuesFound: 'roast issues', noIssues: 'roast no issues' },
      strict: { issuesFound: 'remote strict issues', noIssues: 'remote strict no issues' },
    });
  });

  it('returns source "posthog" when remote template is provided', () => {
    const result = resolveTemplate(remoteTemplateWithoutStyleOverrides, localTemplate);

    expect(result.source).toBe('posthog');
  });
});

// --- generateReviewPrompt (integration) ---

const baseConfig = {
  review_style: 'balanced' as const,
  focus_areas: [],
  custom_instructions: '',
  model_slug: 'test-model',
  max_review_time_minutes: 30,
} satisfies CodeReviewAgentConfig;

describe('generateReviewPrompt', () => {
  it('keeps built-in review guidance when repository instructions are absent', async () => {
    const { prompt } = await generateReviewPrompt(baseConfig, 'owner/repo', 1);

    expect(prompt).toContain('# WHAT TO REVIEW');
    expect(prompt).toContain('Security vulnerabilities (injection, XSS, auth bypass)');
    expect(prompt).not.toContain(`# ${REVIEW_INSTRUCTIONS_FILE} code review instructions`);
  });

  it('replaces built-in review guidance with REVIEW.md instructions at the same prompt point', async () => {
    const repositoryReviewInstructions = [
      'Only flag regressions with direct evidence.',
      '',
      '```ts',
      'const markdown = true;',
      '```',
    ].join('\n');
    const customConfig = {
      ...baseConfig,
      custom_instructions: 'Also consider account-level policy.',
      focus_areas: ['security'],
    } satisfies CodeReviewAgentConfig;

    const { prompt } = await generateReviewPrompt(customConfig, 'owner/repo', 1, {
      repositoryReviewInstructions,
    });

    expect(prompt).toContain('# CUSTOM INSTRUCTIONS');
    expect(prompt).toContain('Also consider account-level policy.');
    expect(prompt).toContain(`# ${REVIEW_INSTRUCTIONS_FILE} code review instructions`);
    expect(prompt).toContain('Only flag regressions with direct evidence.');
    expect(prompt).toContain('```ts\nconst markdown = true;\n```');
    expect(prompt).not.toContain('# WHAT TO REVIEW');
    expect(prompt).not.toContain('Security vulnerabilities (injection, XSS, auth bypass)');
    expect(prompt).toContain('# HARD CONSTRAINTS (READ FIRST)');
    expect(prompt).toContain('# WORKFLOW');
    expect(prompt).toContain('# FOCUS AREAS');
    expect(prompt).toContain('# COMMENT FORMAT');
    expect(prompt).toContain('## Inline Comments API Call');

    expect(prompt.indexOf('# CUSTOM INSTRUCTIONS')).toBeLessThan(
      prompt.indexOf(`# ${REVIEW_INSTRUCTIONS_FILE} code review instructions`)
    );
    expect(prompt.indexOf(`# ${REVIEW_INSTRUCTIONS_FILE} code review instructions`)).toBeLessThan(
      prompt.indexOf('# FOCUS AREAS')
    );
  });

  it('includes roast style guidance when review_style is "roast"', async () => {
    const roastConfig = { ...baseConfig, review_style: 'roast' as const };
    const { prompt } = await generateReviewPrompt(roastConfig, 'owner/repo', 1);

    expect(prompt).toContain('ROAST MODE ACTIVATED');
  });

  it('includes roast comment format when review_style is "roast"', async () => {
    const roastConfig = { ...baseConfig, review_style: 'roast' as const };
    const { prompt } = await generateReviewPrompt(roastConfig, 'owner/repo', 1);

    expect(prompt).toContain('🔥 **The Roast**');
  });

  it('includes roast summary format when review_style is "roast"', async () => {
    const roastConfig = { ...baseConfig, review_style: 'roast' as const };
    const { prompt } = await generateReviewPrompt(roastConfig, 'owner/repo', 1);

    expect(prompt).toContain('Code Review Roast 🔥');
  });

  it('does not include roast guidance when review_style is "balanced"', async () => {
    const { prompt } = await generateReviewPrompt(baseConfig, 'owner/repo', 1);

    expect(prompt).not.toContain('ROAST MODE ACTIVATED');
  });

  it('includes strict style guidance when review_style is "strict"', async () => {
    const strictConfig = {
      ...baseConfig,
      review_style: 'strict' as const,
    } satisfies CodeReviewAgentConfig;
    const { prompt } = await generateReviewPrompt(strictConfig, 'owner/repo', 1);

    expect(prompt).toContain('STRICT REVIEW MODE');
  });

  it('strict prompt does not contain lenient or roast guidance', async () => {
    const strictConfig = {
      ...baseConfig,
      review_style: 'strict' as const,
    } satisfies CodeReviewAgentConfig;
    const { prompt } = await generateReviewPrompt(strictConfig, 'owner/repo', 1);

    expect(prompt).not.toContain('LENIENT REVIEW MODE');
    expect(prompt).not.toContain('ROAST MODE ACTIVATED');
  });

  it('includes lenient style guidance when review_style is "lenient"', async () => {
    const lenientConfig = {
      ...baseConfig,
      review_style: 'lenient' as const,
    } satisfies CodeReviewAgentConfig;
    const { prompt } = await generateReviewPrompt(lenientConfig, 'owner/repo', 1);

    expect(prompt).toContain('LENIENT REVIEW MODE');
  });

  it('lenient prompt does not contain strict or roast guidance', async () => {
    const lenientConfig = {
      ...baseConfig,
      review_style: 'lenient' as const,
    } satisfies CodeReviewAgentConfig;
    const { prompt } = await generateReviewPrompt(lenientConfig, 'owner/repo', 1);

    expect(prompt).not.toContain('STRICT REVIEW MODE');
    expect(prompt).not.toContain('ROAST MODE ACTIVATED');
  });
});

describe('normalizeRepositoryReviewInstructions', () => {
  it('preserves markdown line breaks while trimming and removing control hazards', () => {
    const instructions = [
      ' ',
      '# Policy',
      String.fromCharCode(0, 1) + '```ts',
      'const ok = true;',
      '```',
      ' ',
    ].join('\r\n');
    const normalized = normalizeRepositoryReviewInstructions(instructions);

    expect(normalized).toEqual({
      content: '# Policy\n```ts\nconst ok = true;\n```',
      truncated: false,
    });
  });

  it('treats empty markdown as absent', () => {
    expect(normalizeRepositoryReviewInstructions(' \n\t\n ')).toBeNull();
  });

  it('caps very large instructions and appends a truncation note', () => {
    const normalized = normalizeRepositoryReviewInstructions('a'.repeat(10_005));

    expect(normalized?.content).toHaveLength(
      10_000 + `\n\n[${REVIEW_INSTRUCTIONS_FILE} truncated after 10000 characters.]`.length
    );
    expect(normalized?.content).toContain(
      `[${REVIEW_INSTRUCTIONS_FILE} truncated after 10000 characters.]`
    );
    expect(normalized?.truncated).toBe(true);
  });
});

// --- Incremental review ---

const existingReviewStateWithSummary: ExistingReviewState = {
  summaryComment: {
    commentId: 123,
    body: [
      '<!-- kilo-review -->',
      '## Code Review Summary',
      '',
      '**Status:** 2 Issues Found',
      '',
      '---',
      '<!-- kilo-usage -->',
      '<sub>Reviewed by stale-model · 1,234 tokens</sub>',
      '<!-- kilo-review-guidance -->',
      '<sub>Review guidance: REVIEW.md from base branch `main`</sub>',
    ].join('\n'),
  },
  inlineComments: [
    { id: 1, path: 'src/foo.ts', line: 10, body: '**WARNING:** Issue one', isOutdated: false },
    { id: 2, path: 'src/bar.ts', line: 20, body: '**CRITICAL:** Issue two', isOutdated: true },
  ],
  previousStatus: 'issues-found',
  headCommitSha: 'currentsha123',
};

const existingReviewStateNoSummary: ExistingReviewState = {
  summaryComment: null,
  inlineComments: [],
  previousStatus: 'no-review',
  headCommitSha: 'currentsha123',
};

describe('generateReviewPrompt (incremental review)', () => {
  it('uses incremental workflow when previousHeadSha and summary comment are provided', async () => {
    const { prompt } = await generateReviewPrompt(baseConfig, 'owner/repo', 42, {
      reviewId: 'review-123',
      existingReviewState: existingReviewStateWithSummary,
      previousHeadSha: 'abc123prev',
    });

    expect(prompt).toContain('INCREMENTAL REVIEW MODE');
    expect(prompt).toContain('abc123prev');
    expect(prompt).toContain('git diff abc123prev..HEAD');
    expect(prompt).toContain('2 Issues Found');
    expect(prompt).not.toContain('stale-model');
    expect(prompt).not.toContain('Review guidance: REVIEW.md');
    // Should contain the active comment count (1 active, 1 outdated)
    expect(prompt).toContain('1 active');
    // Should NOT contain the standard workflow step 1
    expect(prompt).not.toContain('gh pr diff 42\n```');
  });

  it('uses standard workflow when previousHeadSha is null', async () => {
    const { prompt } = await generateReviewPrompt(baseConfig, 'owner/repo', 42, {
      reviewId: 'review-123',
      existingReviewState: existingReviewStateWithSummary,
      previousHeadSha: null,
    });

    expect(prompt).not.toContain('INCREMENTAL REVIEW MODE');
    expect(prompt).toContain('gh pr diff 42');
  });

  it('allows GitHub agents to pull latest changes in standard mode', async () => {
    const { prompt } = await generateReviewPrompt(baseConfig, 'owner/repo', 42, {
      reviewId: 'review-123',
      existingReviewState: existingReviewStateNoSummary,
      previousHeadSha: null,
    });

    expect(prompt).toContain('Before reading files, always fetch from remote');
    expect(prompt).toContain('git pull origin $(git branch --show-current)');
    expect(prompt).toContain('gh pr diff 42');
    expect(prompt).not.toContain('DO NOT fetch or pull');
    expect(prompt).not.toContain('Do not run `git fetch`');
  });

  it('uses standard workflow when previousHeadSha is provided but no summary comment', async () => {
    const { prompt } = await generateReviewPrompt(baseConfig, 'owner/repo', 42, {
      reviewId: 'review-123',
      existingReviewState: existingReviewStateNoSummary,
      previousHeadSha: 'abc123prev',
    });

    expect(prompt).not.toContain('INCREMENTAL REVIEW MODE');
    expect(prompt).toContain('gh pr diff 42');
  });

  it('uses standard workflow when existingReviewState is null', async () => {
    const { prompt } = await generateReviewPrompt(baseConfig, 'owner/repo', 42, {
      reviewId: 'review-123',
      existingReviewState: null,
      previousHeadSha: 'abc123prev',
    });

    expect(prompt).not.toContain('INCREMENTAL REVIEW MODE');
    expect(prompt).toContain('gh pr diff 42');
  });

  it('still includes existing inline comments table in incremental mode', async () => {
    const { prompt } = await generateReviewPrompt(baseConfig, 'owner/repo', 42, {
      reviewId: 'review-123',
      existingReviewState: existingReviewStateWithSummary,
      previousHeadSha: 'abc123prev',
    });

    // The inline comments table should still be present (section 10 in generate-prompt.ts)
    expect(prompt).toContain('Existing Inline Comments');
    expect(prompt).toContain('src/foo.ts');
  });

  it('uses UPDATE summary command in incremental mode', async () => {
    const { prompt } = await generateReviewPrompt(baseConfig, 'owner/repo', 42, {
      reviewId: 'review-123',
      existingReviewState: existingReviewStateWithSummary,
      previousHeadSha: 'abc123prev',
    });

    // Summary command should be UPDATE (since summaryComment exists)
    expect(prompt).toContain('UPDATE existing comment');
    expect(prompt).toContain('123'); // commentId
  });

  it('works with GitLab platform in incremental mode', async () => {
    const { prompt } = await generateReviewPrompt(baseConfig, 'group/project', 10, {
      reviewId: 'review-456',
      existingReviewState: existingReviewStateWithSummary,
      platform: 'gitlab',
      gitlabContext: { baseSha: 'base123', startSha: 'start123', headSha: 'head123' },
      previousHeadSha: 'prevsha456',
    });

    expect(prompt).toContain('INCREMENTAL REVIEW MODE');
    expect(prompt).toContain('prevsha456');
    expect(prompt).toContain('glab mr diff');
    expect(prompt).toContain('git pull');
    expect(prompt).toContain('git diff prevsha456..HEAD');
    expect(prompt).not.toContain('DO NOT fetch or pull');
    expect(prompt).not.toContain('Do not run `git fetch`');
  });

  it('allows GitLab agents to fetch and pull latest changes in standard mode', async () => {
    const { prompt } = await generateReviewPrompt(baseConfig, 'group/project', 10, {
      reviewId: 'review-456',
      existingReviewState: existingReviewStateNoSummary,
      platform: 'gitlab',
      gitlabContext: { baseSha: 'base123', startSha: 'start123', headSha: 'head123' },
      previousHeadSha: null,
    });

    expect(prompt).toContain('Before reading files, always fetch from remote');
    expect(prompt).toContain('git fetch origin');
    expect(prompt).toContain('git pull origin $(git branch --show-current)');
    expect(prompt).toContain('glab mr diff 10');
    expect(prompt).toContain(
      'glab api --method POST "projects/group%2Fproject/merge_requests/10/notes"'
    );
    expect(prompt).toContain(
      'glab api --method POST "projects/group%2Fproject/merge_requests/10/discussions"'
    );
    expect(prompt).not.toContain('DO NOT fetch or pull');
    expect(prompt).not.toContain('Do not run `git fetch`');
  });
});
