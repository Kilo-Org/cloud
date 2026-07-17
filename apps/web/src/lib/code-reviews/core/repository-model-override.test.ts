import { CodeReviewAgentConfigSchema } from '@kilocode/db/schema-types';

// Schema validation for repository_model_overrides. Lives in the web tree (not
// packages/db) because the web jest suite is what actually runs in CI.
describe('CodeReviewAgentConfigSchema repository_model_overrides', () => {
  const base = {
    review_style: 'balanced' as const,
    focus_areas: [],
    model_slug: 'anthropic/claude-sonnet-4.6',
  };

  it('accepts a config without repository_model_overrides (backward compatible)', () => {
    expect(CodeReviewAgentConfigSchema.safeParse(base).success).toBe(true);
  });

  it('accepts numeric and UUID override repository ids', () => {
    const result = CodeReviewAgentConfigSchema.safeParse({
      ...base,
      repository_model_overrides: [
        { repository_id: 123, repo_full_name: 'acme/api', model_slug: 'openai/gpt-5' },
        {
          repository_id: '9b3c1d2e-0000-4000-8000-000000000000',
          repo_full_name: 'workspace/repo',
          model_slug: 'openai/gpt-5',
          thinking_effort: 'high',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a null thinking_effort on an override', () => {
    const result = CodeReviewAgentConfigSchema.safeParse({
      ...base,
      repository_model_overrides: [
        {
          repository_id: 1,
          repo_full_name: 'acme/api',
          model_slug: 'openai/gpt-5',
          thinking_effort: null,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an override missing repo_full_name', () => {
    const result = CodeReviewAgentConfigSchema.safeParse({
      ...base,
      repository_model_overrides: [{ repository_id: 1, model_slug: 'openai/gpt-5' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid thinking_effort on an override', () => {
    const result = CodeReviewAgentConfigSchema.safeParse({
      ...base,
      repository_model_overrides: [
        {
          repository_id: 1,
          repo_full_name: 'acme/api',
          model_slug: 'openai/gpt-5',
          thinking_effort: 'high-3', // digits/hyphen not allowed by the regex
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});
