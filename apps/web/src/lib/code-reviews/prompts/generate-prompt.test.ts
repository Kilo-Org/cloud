import type { CodeReviewAgentConfig } from '@/lib/agent-config/core/types';
import DEFAULT_PROMPT_TEMPLATE_GITHUB from './default-prompt-template.json';
import DEFAULT_PROMPT_TEMPLATE_GITLAB from './default-prompt-template-gitlab.json';
import { generateReviewPrompt, PromptTemplateSchema } from './generate-prompt';
import type { ExistingReviewState } from './generate-prompt';
import {
  REVIEW_INSTRUCTIONS_FILE,
  normalizeRepositoryReviewInstructions,
} from './repository-review-instructions';
import { REVIEW_SUMMARY_HISTORY_START } from '../summary/history';

describe('checked-in prompt templates', () => {
  it('validates the GitHub template', () => {
    expect(PromptTemplateSchema.safeParse(DEFAULT_PROMPT_TEMPLATE_GITHUB).success).toBe(true);
  });

  it('validates the GitLab template', () => {
    expect(PromptTemplateSchema.safeParse(DEFAULT_PROMPT_TEMPLATE_GITLAB).success).toBe(true);
  });
});

const baseConfig = {
  review_style: 'balanced' as const,
  focus_areas: [],
  custom_instructions: '',
  model_slug: 'test-model',
} satisfies CodeReviewAgentConfig;

describe('generateReviewPrompt', () => {
  it('always uses the checked-in GitHub template version and commands', async () => {
    const result = await generateReviewPrompt(baseConfig, 'owner/repo', 42);

    expect(result.version).toBe(DEFAULT_PROMPT_TEMPLATE_GITHUB.version);
    expect(result.prompt).toContain('gh pr diff 42');
    expect(result.prompt).toContain('gh api repos/owner/repo/pulls/42/reviews');
    expect(result.prompt).not.toContain('glab api');
  });

  it('always uses the checked-in GitLab template version and commands', async () => {
    const result = await generateReviewPrompt(baseConfig, 'group/project', 10, {
      platform: 'gitlab',
      gitlabContext: { baseSha: 'base123', startSha: 'start123', headSha: 'head123' },
    });

    expect(result.version).toBe(DEFAULT_PROMPT_TEMPLATE_GITLAB.version);
    expect(result.prompt).toContain('glab mr diff 10');
    expect(result.prompt).toContain(
      'glab api --method POST "projects/group%2Fproject/merge_requests/10/discussions"'
    );
    expect(result.prompt).not.toContain('gh api');
  });

  it('keeps built-in review guidance when repository instructions are absent', async () => {
    const { prompt } = await generateReviewPrompt(baseConfig, 'owner/repo', 1);

    expect(prompt).toContain('# WHAT TO REVIEW');
    expect(prompt).toContain('Security vulnerabilities (injection, XSS, auth bypass)');
    expect(prompt).not.toContain(`# ${REVIEW_INSTRUCTIONS_FILE} code review instructions`);
  });

  it('includes GitHub diff line-number safeguards', async () => {
    const { prompt } = await generateReviewPrompt(baseConfig, 'owner/repo', 1);

    expect(prompt).toContain('# GITHUB DIFF LINE RULES');
    expect(prompt).toContain('gh pr diff 1');
    expect(prompt).toContain('Use the NEW file line number from the RIGHT side of the diff');
    expect(prompt).toContain('Line could not be resolved');
  });

  it('does not include GitHub diff line-number safeguards for GitLab', async () => {
    const { prompt } = await generateReviewPrompt(baseConfig, 'group/project', 10, {
      platform: 'gitlab',
      gitlabContext: { baseSha: 'base123', startSha: 'start123', headSha: 'head123' },
    });

    expect(prompt).not.toContain('# GITHUB DIFF LINE RULES');
  });

  it('includes tiered sub-agent usage guidance for GitHub', async () => {
    const { prompt } = await generateReviewPrompt(baseConfig, 'owner/repo', 1);

    expect(prompt).toContain('# SUB-AGENT USAGE');
    expect(prompt).toContain('Tiny: up to 2 files and under 100 changed lines: use 0 sub-agents');
    expect(prompt).toContain('Small: 3-5 files or 100-300 changed lines: use at most 1 sub-agent');
    expect(prompt).toContain(
      'Medium and larger: 6+ files or more than 300 changed lines: use the full 6 sub-agents'
    );
  });

  it('includes tiered sub-agent usage guidance for GitLab', async () => {
    const { prompt } = await generateReviewPrompt(baseConfig, 'group/project', 10, {
      platform: 'gitlab',
      gitlabContext: { baseSha: 'base123', startSha: 'start123', headSha: 'head123' },
    });

    expect(prompt).toContain('# SUB-AGENT USAGE');
    expect(prompt).toContain('Tiny: up to 2 files and under 100 changed lines: use 0 sub-agents');
    expect(prompt).toContain('Small: 3-5 files or 100-300 changed lines: use at most 1 sub-agent');
    expect(prompt).toContain(
      'Medium and larger: 6+ files or more than 300 changed lines: use the full 6 sub-agents'
    );
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
    expect(prompt).toContain('# SUB-AGENT USAGE');
    expect(prompt).toContain("replace Kilo's default review guidance for sub-agent usage");
    expect(prompt).toContain('formatting/output requirements');
    expect(prompt).not.toContain('# WHAT TO REVIEW');
    expect(prompt).not.toContain('Security vulnerabilities (injection, XSS, auth bypass)');

    expect(prompt).toContain('operating in READ-ONLY, NON-INTERACTIVE mode');
    expect(prompt).toContain('# HARD CONSTRAINTS (READ FIRST)');
    expect(prompt).toContain('# WORKFLOW');
    expect(prompt).toContain('gh pr diff 1');
    expect(prompt).toContain('# FOCUS AREAS');
    expect(prompt).toContain('Pay special attention to: security');
    expect(prompt).toContain('# COMMENT FORMAT');
    expect(prompt).toContain('<!-- kilo-review -->');
    expect(prompt).toContain('gh api repos/owner/repo/issues/1/comments');
    expect(prompt).toContain('gh api repos/owner/repo/pulls/1/reviews');

    const repositoryPolicyIndex = prompt.indexOf(
      `# ${REVIEW_INSTRUCTIONS_FILE} code review instructions`
    );
    expect(prompt.indexOf('# SUB-AGENT USAGE')).toBeLessThan(repositoryPolicyIndex);
    expect(prompt.indexOf('# CUSTOM INSTRUCTIONS')).toBeLessThan(repositoryPolicyIndex);
    expect(prompt.indexOf('# HARD CONSTRAINTS (READ FIRST)')).toBeLessThan(repositoryPolicyIndex);
    expect(prompt.indexOf('# WORKFLOW')).toBeLessThan(repositoryPolicyIndex);
    expect(repositoryPolicyIndex).toBeLessThan(prompt.indexOf('# FOCUS AREAS'));
    expect(repositoryPolicyIndex).toBeLessThan(prompt.indexOf('# COMMENT FORMAT'));
    expect(repositoryPolicyIndex).toBeLessThan(prompt.indexOf('## Inline Comments API Call'));
  });

  it('keeps GitLab safety, workflow, commands, and output with REVIEW.md policy', async () => {
    const { prompt, version } = await generateReviewPrompt(baseConfig, 'group/project', 10, {
      platform: 'gitlab',
      gitlabContext: { baseSha: 'base123', startSha: 'start123', headSha: 'head123' },
      repositoryReviewInstructions: '# Project policy\n\nOnly flag regressions with evidence.',
    });

    expect(version).toBe(DEFAULT_PROMPT_TEMPLATE_GITLAB.version);
    expect(prompt).toContain('Only flag regressions with evidence.');
    expect(prompt).toContain('# SUB-AGENT USAGE');
    expect(prompt).toContain("replace Kilo's default review guidance for sub-agent usage");
    expect(prompt).toContain('formatting/output requirements');
    expect(prompt).not.toContain('Security vulnerabilities (injection, XSS, auth bypass)');
    expect(prompt).toContain('operating in READ-ONLY, NON-INTERACTIVE mode');
    expect(prompt).toContain('# HARD CONSTRAINTS (READ FIRST)');
    expect(prompt).toContain('glab mr diff 10');
    expect(prompt).toContain(
      'glab api --method POST "projects/group%2Fproject/merge_requests/10/notes"'
    );
    expect(prompt).toContain(
      'glab api --method POST "projects/group%2Fproject/merge_requests/10/discussions"'
    );
    expect(prompt).toContain('<!-- kilo-review -->');
  });

  it('includes GitHub inline comment footer guidance after the comment format', async () => {
    const { prompt } = await generateReviewPrompt(baseConfig, 'owner/repo', 1);

    expect(prompt).toContain('## Inline Comment Footer');
    expect(prompt).toContain(
      'Reply with `@kilocode-bot fix it` to have Kilo Code address this issue.'
    );
    expect(prompt).toContain('after any fenced `suggestion` block');
    expect(prompt).toContain(
      'Do not add this footer to the review summary, top-level review body, or any non-inline comment.'
    );
    expect(prompt.indexOf('# COMMENT FORMAT')).toBeLessThan(
      prompt.indexOf('## Inline Comment Footer')
    );
    expect(prompt.indexOf('## Inline Comment Footer')).toBeLessThan(
      prompt.indexOf('# CONTEXT FOR THIS PR')
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

const existingReviewStateWithHistory: ExistingReviewState = {
  summaryComment: {
    commentId: 456,
    body: [
      '<!-- kilo-review -->',
      '## Code Review Summary',
      '',
      '**Status:** No Issues Found | **Recommendation:** Merge',
      '',
      '<details>',
      '<summary><b>Files Reviewed (1 file)</b></summary>',
      '',
      '- `src/current.ts`',
      '',
      '</details>',
      '',
      '<!-- kilo-review-history -->',
      '<details>',
      '<summary><b>Previous Review Summary</b> (commit oldwarn)</summary>',
      '',
      '_Current summary above is authoritative. Previous snapshots are kept for context only._',
      '',
      '<!-- kilo-review-history-entry -->',
      '### Previous review (commit oldwarn)',
      '',
      '**Status:** 1 Issue Found | **Recommendation:** Address before merge',
      '',
      'Archived WARNING that should not be active context.',
      '',
      '</details>',
      '<!-- /kilo-review-history -->',
      '',
      '---',
      '<!-- kilo-usage -->',
      '<sub>Reviewed by stale-model - 123 tokens</sub>',
    ].join('\n'),
  },
  inlineComments: [],
  previousStatus: 'no-issues',
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

  it('does not send archived summary history through the model', async () => {
    const { prompt } = await generateReviewPrompt(baseConfig, 'owner/repo', 42, {
      reviewId: 'review-123',
      existingReviewState: existingReviewStateWithSummary,
      previousHeadSha: 'abc123prev',
    });

    expect(prompt).toContain('2 Issues Found');
    expect(prompt).toContain('UPDATE existing comment');
    expect(prompt).not.toContain('## Previous Summary Preservation');
    expect(prompt).not.toContain(REVIEW_SUMMARY_HISTORY_START);
    expect(prompt).not.toContain('old-model');
  });

  it('does not add summary preservation instructions outside incremental mode', async () => {
    const { prompt } = await generateReviewPrompt(baseConfig, 'owner/repo', 42, {
      reviewId: 'review-123',
      existingReviewState: existingReviewStateWithSummary,
      previousHeadSha: null,
    });

    expect(prompt).not.toContain('INCREMENTAL REVIEW MODE');
    expect(prompt).not.toContain('## Previous Summary Preservation');
    expect(prompt).not.toContain(REVIEW_SUMMARY_HISTORY_START);
  });

  it('does not add previous summary preservation for create prompts', async () => {
    const { prompt } = await generateReviewPrompt(baseConfig, 'owner/repo', 42, {
      reviewId: 'review-123',
      existingReviewState: existingReviewStateNoSummary,
      previousHeadSha: null,
    });

    expect(prompt).not.toContain('## Previous Summary Preservation');
    expect(prompt).toContain('CREATE new comment');
  });

  it('excludes archived history from incremental previous-summary context', async () => {
    const { prompt } = await generateReviewPrompt(baseConfig, 'owner/repo', 42, {
      reviewId: 'review-123',
      existingReviewState: existingReviewStateWithHistory,
      previousHeadSha: 'abc123prev',
    });
    const previousSummaryStart = prompt.indexOf('## Previous Review Summary');
    const previousSummaryEnd = prompt.indexOf('## Previous Inline Comments');
    const previousSummaryContext = prompt.slice(previousSummaryStart, previousSummaryEnd);

    expect(previousSummaryContext).toContain('No Issues Found');
    expect(previousSummaryContext).toContain('src/current.ts');
    expect(previousSummaryContext).not.toContain('Archived WARNING');
    expect(previousSummaryContext).not.toContain(REVIEW_SUMMARY_HISTORY_START);
    expect(previousSummaryContext).not.toContain('stale-model');
    expect(prompt).not.toContain('Archived WARNING');
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

  it('does not send summary history through GitLab update prompts', async () => {
    const { prompt } = await generateReviewPrompt(baseConfig, 'group/project', 10, {
      reviewId: 'review-456',
      existingReviewState: existingReviewStateWithSummary,
      platform: 'gitlab',
      gitlabContext: { baseSha: 'base123', startSha: 'start123', headSha: 'head123' },
      previousHeadSha: 'prevsha456',
    });

    expect(prompt).toContain('UPDATE existing note');
    expect(prompt).not.toContain('## Previous Summary Preservation');
    expect(prompt).not.toContain(REVIEW_SUMMARY_HISTORY_START);
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

  it('does not include GitHub inline comment footer guidance for GitLab prompts', async () => {
    const { prompt } = await generateReviewPrompt(baseConfig, 'group/project', 10, {
      platform: 'gitlab',
      gitlabContext: { baseSha: 'base123', startSha: 'start123', headSha: 'head123' },
    });

    expect(prompt).not.toContain('## Inline Comment Footer');
    expect(prompt).not.toContain('@kilocode-bot fix it');
  });
});
