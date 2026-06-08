const mockGenerateText = jest.fn();
const mockResolveReviewMemoryActor = jest.fn();
const mockResolveReviewMemoryModel = jest.fn();
const mockCreateReviewMemoryGatewayProvider = jest.fn();

jest.mock('ai', () => ({
  generateText: (...args: unknown[]) => mockGenerateText(...args),
}));

jest.mock('./llm', () => {
  const actual = jest.requireActual('./llm');
  return {
    ...actual,
    resolveReviewMemoryActor: (...args: unknown[]) => mockResolveReviewMemoryActor(...args),
    resolveReviewMemoryModel: (...args: unknown[]) => mockResolveReviewMemoryModel(...args),
    createReviewMemoryGatewayProvider: (...args: unknown[]) =>
      mockCreateReviewMemoryGatewayProvider(...args),
  };
});

import type { CodeReviewMemoryProposal, User } from '@kilocode/db/schema';
import { generateIntegratedReviewGuidanceWithGateway } from './review-md-integration';

describe('review md integration generator', () => {
  const owner = { type: 'user' as const, id: 'user-1' };
  const proposal = {
    title: 'Clarify widgets',
    proposal_type: 'clarify',
    scope_kind: 'repository',
    scope_value: null,
    rationale: 'Maintainers repeatedly corrected widget comments.',
    proposed_markdown: '### Widgets\n\nAvoid flagging intentional widgets.',
  } as CodeReviewMemoryProposal;

  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveReviewMemoryActor.mockResolvedValue({ id: 'actor-1' } as User);
    mockResolveReviewMemoryModel.mockResolvedValue({ modelSlug: 'test-model' });
    mockCreateReviewMemoryGatewayProvider.mockReturnValue({
      chatModel: (modelSlug: string) => ({ modelSlug }),
    });
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        status: 'updated',
        updatedReviewMd: '# REVIEW\n\n## Widgets\n\nAvoid flagging intentional widgets.\n',
        integrationSummary: 'Added widget guidance.',
      }),
      usage: { inputTokens: 12, outputTokens: 34 },
    });
  });

  function generate() {
    return generateIntegratedReviewGuidanceWithGateway({
      owner,
      platform: 'github',
      repoFullName: 'acme/widgets',
      existingReviewMd: '# REVIEW\n',
      proposal,
    });
  }

  it('parses plain JSON integration output', async () => {
    const result = await generate();

    expect(result).toEqual({
      status: 'updated',
      updatedReviewMd: '# REVIEW\n\n## Widgets\n\nAvoid flagging intentional widgets.\n',
      integrationSummary: 'Added widget guidance.',
      tokensIn: 12,
      tokensOut: 34,
    });
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { modelSlug: 'test-model' },
        prompt: expect.stringContaining('Repository: acme/widgets'),
        maxOutputTokens: 8_000,
      })
    );
  });

  it('parses fenced JSON integration output', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: `\`\`\`json
{"status":"already_present","updatedReviewMd":null,"integrationSummary":"Existing guidance covers it."}
\`\`\``,
      usage: { inputTokens: 9, outputTokens: 7 },
    });

    await expect(generate()).resolves.toEqual({
      status: 'already_present',
      updatedReviewMd: null,
      integrationSummary: 'Existing guidance covers it.',
      tokensIn: 9,
      tokensOut: 7,
    });
  });

  it('rejects updated REVIEW.md with Review Memory branding', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify({
        status: 'updated',
        updatedReviewMd: '# REVIEW\n\n## Review memory\n\nAvoid noisy comments.\n',
        integrationSummary: 'Added branded guidance.',
      }),
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    await expect(generate()).rejects.toThrow('must not mention Review Memory');
  });

  it('rejects updated status without updatedReviewMd', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify({
        status: 'updated',
        updatedReviewMd: null,
        integrationSummary: 'Forgot content.',
      }),
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    await expect(generate()).rejects.toThrow('without updatedReviewMd');
  });

  it('allows already_present without updatedReviewMd', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify({
        status: 'already_present',
        updatedReviewMd: null,
        integrationSummary: 'Existing guidance already covers it.',
      }),
      usage: { inputTokens: 3, outputTokens: 2 },
    });

    await expect(generate()).resolves.toEqual({
      status: 'already_present',
      updatedReviewMd: null,
      integrationSummary: 'Existing guidance already covers it.',
      tokensIn: 3,
      tokensOut: 2,
    });
  });
});
