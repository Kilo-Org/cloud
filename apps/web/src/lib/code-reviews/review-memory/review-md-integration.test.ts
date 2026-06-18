import { ReviewMemoryProposalDraftSchema, validateReviewMemoryProposalDraft } from './aggregation';
import {
  ReviewMdIntegrationOutputSchema,
  validateReviewMdIntegrationOutput,
} from './review-md-integration';

describe('Review Memory model output semantics', () => {
  it('accepts a complete REVIEW.md update', () => {
    const output = ReviewMdIntegrationOutputSchema.parse({
      status: 'updated',
      updatedReviewMd: '# Code review\n\nCheck generated fixtures against their source.',
      integrationSummary: 'Added generated fixture guidance.',
    });

    expect(validateReviewMdIntegrationOutput(output)).toEqual(output);
  });

  it.each([null, '', '   '])(
    'rejects updated status without non-empty REVIEW.md content (%p)',
    updatedReviewMd => {
      const parsed = ReviewMdIntegrationOutputSchema.safeParse({
        status: 'updated',
        updatedReviewMd,
        integrationSummary: 'Attempted update.',
      });

      if (!parsed.success) {
        expect(updatedReviewMd).toBe('');
        return;
      }
      expect(() => validateReviewMdIntegrationOutput(parsed.data)).toThrow(
        /without updatedReviewMd|empty REVIEW\.md/
      );
    }
  );

  it('rejects Review Memory branding in integrated guidance', () => {
    const output = ReviewMdIntegrationOutputSchema.parse({
      status: 'updated',
      updatedReviewMd: '# Review Memory\n\nRemember maintainer preferences.',
      integrationSummary: 'Added guidance.',
    });

    expect(() => validateReviewMdIntegrationOutput(output)).toThrow(
      'Integrated REVIEW.md must not mention Review Memory.'
    );
  });

  it('retains proposal branding validation after structured parsing', () => {
    const draft = ReviewMemoryProposalDraftSchema.parse({
      status: 'propose',
      title: 'Generated fixtures',
      rationale: 'Maintainers repeatedly corrected generated fixture comments.',
      proposedMarkdown: 'Kilo should ignore generated fixtures.',
      positiveCount: 0,
      negativeCount: 2,
      neutralCount: 0,
      evidenceEventIds: [],
    });

    expect(() => validateReviewMemoryProposalDraft(draft)).toThrow(
      'Review Memory proposal must not mention Kilo, Review Memory, feedback systems, or LLMs.'
    );
  });
});
