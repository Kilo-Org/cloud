import type { CodeReviewAgentConfig } from '@/lib/agent-config/core/types';
import { resolveTemplate, generateReviewPrompt } from './generate-prompt';
import type { PromptTemplate } from './generate-prompt';

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
