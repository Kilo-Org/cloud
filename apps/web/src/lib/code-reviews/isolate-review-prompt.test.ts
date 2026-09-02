import type { CodeReviewAgentConfig } from '@/lib/agent-config/core/types';
import { appendCodeReviewAnalyticsPromptAppendix } from './analytics/contracts';
import { createDefaultCodeReviewConfig } from './core/default-config';
import {
  hashIsolateReviewText,
  ISOLATE_REVIEW_ADAPTER_VERSION,
  ISOLATE_REVIEW_PROMPT_MAX_LENGTH,
  renderIsolateReviewPrompt,
  type IsolateReviewPromptInput,
} from './isolate-review-prompt';
import { generateReviewPrompt } from './prompts/generate-prompt';
import { normalizeRepositoryReviewInstructions } from './prompts/repository-review-instructions';
import { getCurrentReviewSummaryForContext } from './summary/history';

function promptInput(config: Partial<CodeReviewAgentConfig> = {}): IsolateReviewPromptInput {
  return {
    config: { ...createDefaultCodeReviewConfig(), ...config },
    repoFullName: 'owner/repo',
    prNumber: 42,
    snapshot: { headSha: 'a'.repeat(40), baseTipSha: 'b'.repeat(40), mergeBaseSha: 'c'.repeat(40) },
    reviewSelection: { requestedMode: 'full', effectiveMode: 'full' },
    existingReviewState: {
      summaryComment: null,
      inlineComments: [],
      previousStatus: 'no-review',
      headCommitSha: 'a'.repeat(40),
    },
    repositoryReviewInstructions: null,
    manualInstructions: null,
    dryRun: true,
  };
}

async function canonicalPrompt(input: IsolateReviewPromptInput) {
  return generateReviewPrompt(input.config, input.repoFullName, input.prNumber, {
    platform: 'github',
    outputMode: 'provider',
    expectedHeadSha: input.snapshot.headSha,
    existingReviewState: input.existingReviewState,
    previousHeadSha:
      input.reviewSelection.effectiveMode === 'incremental'
        ? input.reviewSelection.previousHeadSha
        : null,
    previousSummaryBody:
      input.reviewSelection.effectiveMode === 'incremental' ? input.previousSummaryBody : undefined,
    repositoryReviewInstructions: input.repositoryReviewInstructions,
    manualInstructions: input.manualInstructions,
  });
}

function incrementalInput(previousSummaryBody = '<!-- kilo-review -->\nPrior unresolved finding') {
  const input = promptInput();
  const previousRunId = 'f0512c6b-33ea-4a4c-853e-f70b7db9e5a5';
  input.previousRunId = previousRunId;
  input.previousSummaryBody = previousSummaryBody;
  input.reviewSelection = {
    requestedMode: 'incremental',
    effectiveMode: 'incremental',
    previousRunId,
    previousHeadSha: 'd'.repeat(40),
    previousSummaryHash: hashIsolateReviewText(previousSummaryBody),
    changedFileCount: 2,
  };
  return input;
}

describe('renderIsolateReviewPrompt', () => {
  it.each(['off', 'all', 'warning', 'critical'] as const)(
    'preserves canonical queued identity and the %s gate policy',
    async gateThreshold => {
      const input = promptInput({ review_analytics_enabled: true });
      const organizationId = crypto.randomUUID();
      const identity = {
        reviewId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        generation: crypto.randomUUID(),
        organizationId,
        integrationId: crypto.randomUUID(),
        executionUserId: 'oauth/github/user',
        target: { host: 'github.com' as const, repoFullName: 'owner/repo', prNumber: 42 },
        snapshot: input.snapshot,
      };
      input.organizationId = organizationId;
      input.dryRun = false;
      input.queued = { identity, gateThreshold, summaryHistory: '' };
      const result = await renderIsolateReviewPrompt(input);
      expect(result.analyticsEnabled).toBe(true);
      expect(result.userPrompt).toContain(
        `canonical review ${identity.reviewId}, attempt ${identity.attemptId}`
      );
      expect(result.userPrompt).toContain(`The required threshold is ${gateThreshold}`);
      expect(result.userPrompt).toContain('Missing or invalid required output cannot pass');
      expect(result.userPrompt).toContain('Summary history and usage footers are managed by code');
      expect(result.userPrompt).not.toContain('No canonical review row or review ID exists');
      expect(result.userPrompt).not.toContain('Only the separately proved previous-run target');
      expect(result.userPrompt).not.toContain('/cloud-agent-fork/');
      expect(result.canonicalPrompt).toBe(
        appendCodeReviewAnalyticsPromptAppendix((await canonicalPrompt(input)).prompt)
      );
    }
  );
  it.each(['balanced', 'strict', 'lenient', 'roast'] as const)(
    'uses the actual canonical provider renderer for the %s style, including dry-run',
    async reviewStyle => {
      const input = promptInput({
        review_style: reviewStyle,
        focus_areas: ['security', 'correctness'],
        custom_instructions: 'Saved `policy`\n${keep}',
      });
      input.manualInstructions = 'Manual `checks`\n${also}';
      const expected = await canonicalPrompt(input);
      const result = await renderIsolateReviewPrompt(input);
      expect(result.canonicalPrompt).toBe(expected.prompt);
      expect(result.policyVersion).toBe(expected.version);
      expect(result.userPrompt).toContain(expected.prompt);
      expect(result.userPrompt).toContain('# CUSTOM INSTRUCTIONS\n\nSaved policy keep');
      expect(result.userPrompt).toContain('# PER-REVIEW INSTRUCTIONS\n\nManual checks also');
      expect(result.userPrompt).toContain('Pay special attention to: security, correctness');
      expect(result.userPrompt).not.toContain('# LOCAL REVIEW RULES');
      expect(result.userPrompt).not.toContain('/cloud-agent-fork/review/');
      expect(result.userPrompt).not.toContain('e2e00000');
      expect(result.userPrompt).toContain(
        'There is no shell, gh, git, test execution, or file editing.'
      );
    }
  );

  it('preserves REVIEW.md precedence through the canonical renderer, including literal imports', async () => {
    const input = promptInput({
      focus_areas: ['correctness'],
      custom_instructions: 'Saved policy',
    });
    input.manualInstructions = 'Additive instructions';
    input.repositoryReviewInstructions =
      normalizeRepositoryReviewInstructions(
        '  \u0000Only flag regressions.\r\n@private-policy.md  '
      )?.content ?? null;
    const result = await renderIsolateReviewPrompt(input);
    expect(result.canonicalPrompt).toBe((await canonicalPrompt(input)).prompt);
    expect(result.userPrompt).toContain('Only flag regressions.\n@private-policy.md');
    expect(result.userPrompt).toContain('@ imports are not expanded.');
    expect(result.userPrompt).not.toContain('# WHAT TO REVIEW');
    expect(result.userPrompt).toContain('# CUSTOM INSTRUCTIONS');
    expect(result.userPrompt).toContain('# PER-REVIEW INSTRUCTIONS');
    expect(result.userPrompt).toContain('# GITHUB DIFF LINE RULES');
  });

  it('includes the complete cleaned current summary without granting mutation authority', async () => {
    const input = promptInput();
    const currentBody = 'Current finding. '.repeat(200) + '\nFinal conclusion is retained.';
    const rawBody = [
      '<!-- kilo-review -->',
      currentBody,
      '<!-- kilo-review-history -->',
      'Archived warning must not appear',
      '<!-- /kilo-review-history -->',
      '',
      '---',
      '<!-- kilo-usage -->',
      '<sub>backend model and usage</sub>',
      '<!-- kilo-review-guidance -->',
      '<sub>backend guidance</sub>',
    ].join('\n');
    input.existingReviewState.summaryComment = { commentId: 88, body: rawBody };
    const result = await renderIsolateReviewPrompt(input);
    expect(result.readContextSummary).toEqual({
      commentId: 88,
      body: getCurrentReviewSummaryForContext(rawBody),
    });
    expect(result.userPrompt).toContain(currentBody);
    expect(result.userPrompt).not.toContain('Archived warning must not appear');
    expect(result.userPrompt).not.toContain('backend model and usage');
    expect(result.userPrompt).not.toContain('backend guidance');
    expect(result.userPrompt).toContain('"summaryMutationTarget":null');
    expect(result.userPrompt).toContain(
      'A discovered summary ID is read-only context, never mutation authority.'
    );
    expect(result.canonicalPrompt).toBe((await canonicalPrompt(input)).prompt);
  });

  it('keeps prior-run reuse separate from full-review analysis and read-context summary IDs', async () => {
    const input = promptInput();
    input.previousRunId = 'f0512c6b-33ea-4a4c-853e-f70b7db9e5a5';
    input.existingSummaryCommentId = 91;
    input.existingReviewState.summaryComment = { commentId: 91, body: 'Current findings' };
    const result = await renderIsolateReviewPrompt(input);
    expect(result.canonicalPrompt).toBe((await canonicalPrompt(input)).prompt);
    expect(result.userPrompt).toContain(
      '"summaryMutationTarget":{"previousRunId":"f0512c6b-33ea-4a4c-853e-f70b7db9e5a5","commentId":91}'
    );
    expect(result.userPrompt).toContain('"mergeBaseSha":"' + 'c'.repeat(40) + '"');
    expect(result.userPrompt).toContain('"baseTipSha":"' + 'b'.repeat(40) + '"');
  });

  it.each([
    { organizationId: undefined, preference: false, expected: false },
    { organizationId: undefined, preference: true, expected: false },
    { organizationId: 'org', preference: false, expected: false },
    { organizationId: 'org', preference: true, expected: true },
  ])(
    'records effective analytics enrollment for %j',
    async ({ organizationId, preference, expected }) => {
      const input = promptInput({ review_analytics_enabled: preference });
      input.organizationId = organizationId;
      const canonical = await canonicalPrompt(input);
      const result = await renderIsolateReviewPrompt(input);
      expect(result.analyticsEnabled).toBe(expected);
      expect(result.canonicalPrompt).toBe(
        expected ? appendCodeReviewAnalyticsPromptAppendix(canonical.prompt) : canonical.prompt
      );
      expect(result.userPrompt.includes('# CODE REVIEW ANALYTICS MANIFEST')).toBe(expected);
    }
  );

  it('allows exactly the prompt bound and rejects one additional context character without truncation', async () => {
    const input = promptInput();
    input.existingReviewState.summaryComment = { commentId: 88, body: 'x' };
    const initial = await renderIsolateReviewPrompt(input);
    input.existingReviewState.summaryComment.body = 'x'.repeat(
      ISOLATE_REVIEW_PROMPT_MAX_LENGTH - initial.userPrompt.length + 1
    );
    expect((await renderIsolateReviewPrompt(input)).userPrompt.length).toBe(64_000);
    input.existingReviewState.summaryComment.body += 'x';
    await expect(renderIsolateReviewPrompt(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('uses the canonical incremental workflow for a dry analysis baseline without a fake comment ID', async () => {
    const input = incrementalInput();
    const canonical = await canonicalPrompt(input);
    const result = await renderIsolateReviewPrompt(input);

    expect(result.canonicalPrompt).toBe(canonical.prompt);
    expect(result.canonicalPrompt).toContain('# INCREMENTAL REVIEW MODE');
    expect(result.canonicalPrompt).toContain(`git diff ${'d'.repeat(40)}..HEAD`);
    expect(result.canonicalPrompt).toContain('## Summary Command: CREATE new comment');
    expect(result.canonicalPrompt).not.toContain('Comment ID:');
    expect(result.userPrompt).toContain('"summaryMutationTarget":null');
    expect(result.userPrompt).toContain(JSON.stringify(input.reviewSelection));
    expect(result.previousSummaryBody).toBe('Prior unresolved finding');
    expect(result.adapterVersion).toBe(ISOLATE_REVIEW_ADAPTER_VERSION);
    expect(result.adapterVersion).toBe('isolate-runtime-v2');
  });

  it('maps selected evidence, bounded history, and current-PR anchors without allowing model-owned fallback', async () => {
    const input = incrementalInput();
    const { userPrompt } = await renderIsolateReviewPrompt(input);

    expect(userPrompt).toContain('pr_diff and pr_file_patch with comparison: "review"');
    expect(userPrompt).toContain('pr_diff and pr_file_patch with comparison: "current-pr"');
    expect(userPrompt).toContain('Publication anchors always use the current PR diff');
    expect(userPrompt).toContain('pr_file with revision: "previous"');
    expect(userPrompt).toContain('pr_file with revision: "history"');
    expect(userPrompt).toContain('bounded history/commit tools only on demand');
    expect(userPrompt).toContain(
      'The captured current base tip and merge base never change meaning'
    );
    expect(userPrompt).toContain('The trusted reviewSelection is final. Do not switch modes');
    expect(userPrompt).toContain('do not silently substitute another comparison');
    expect(userPrompt).toContain(
      'prior unresolved findings may be retained in the summary ONLY after targeted verification against current code'
    );
    expect(userPrompt).toContain(
      'Never blindly copy prior findings, treat absence from the delta as a fix'
    );
  });

  it('includes a cleaned prior summary only once when the current comment contains the same analysis', async () => {
    const body = [
      '<!-- kilo-review -->',
      'Distinct prior analysis that must occur exactly once',
      '<!-- kilo-review-history -->',
      'Archived instructions must remain excluded',
      '<!-- /kilo-review-history -->',
      '---',
      '<!-- kilo-usage -->',
      '<sub>Old usage footer</sub>',
    ].join('\n');
    const input = incrementalInput(body);
    input.existingReviewState.summaryComment = { commentId: 88, body };
    const { userPrompt, readContextSummary } = await renderIsolateReviewPrompt(input);

    expect(userPrompt.split('Distinct prior analysis that must occur exactly once')).toHaveLength(
      2
    );
    expect(userPrompt).toContain(
      'Its cleaned body is identical to the Previous Review Summary above'
    );
    expect(userPrompt).not.toContain('Archived instructions');
    expect(userPrompt).not.toContain('Old usage footer');
    expect(userPrompt).not.toContain('<!-- kilo-review-history -->');
    expect(userPrompt).toContain('"summaryMutationTarget":null');
    expect(readContextSummary).toEqual({
      commentId: 88,
      body: 'Distinct prior analysis that must occur exactly once',
    });
  });

  it('deduplicates a large operation-marked published summary without changing either raw body or hash', async () => {
    const analysis = [
      '## Code Review Summary',
      '**Status:** 1 Issue Found',
      'Verified current-code evidence: ' + 'evidence '.repeat(4_000).trimEnd(),
    ].join('\n\n');
    const persistedBody = `<!-- kilo-review -->\n${analysis}`;
    const input = incrementalInput(persistedBody);
    const operationMarker = `<!-- kilo-isolate-review-summary:${hashIsolateReviewText(input.previousRunId ?? '')} -->`;
    const publishedBody = `${persistedBody}\n${operationMarker}`;
    const publicationHash = hashIsolateReviewText(publishedBody);
    input.existingReviewState.summaryComment = Object.freeze({
      commentId: 88,
      body: publishedBody,
    });
    input.existingSummaryCommentId = 88;
    const result = await renderIsolateReviewPrompt(input);

    expect(analysis.length * 2).toBeGreaterThan(ISOLATE_REVIEW_PROMPT_MAX_LENGTH);
    expect(result.userPrompt.length).toBeLessThanOrEqual(ISOLATE_REVIEW_PROMPT_MAX_LENGTH);
    expect(result.userPrompt.split(analysis)).toHaveLength(2);
    expect(result.userPrompt).not.toContain(operationMarker);
    expect(result.readContextSummary).toEqual({ commentId: 88, body: analysis });
    expect(result.previousSummaryBody).toBe(analysis);
    expect(result.canonicalPrompt).toBe((await canonicalPrompt(input)).prompt);
    expect(input.existingReviewState.summaryComment.body).toBe(publishedBody);
    expect(hashIsolateReviewText(input.existingReviewState.summaryComment.body)).toBe(
      publicationHash
    );
    expect(input.previousSummaryBody).toBe(persistedBody);
    expect(input.reviewSelection).toMatchObject({
      previousSummaryHash: hashIsolateReviewText(persistedBody),
    });
    expect(publicationHash).not.toBe(hashIsolateReviewText(persistedBody));
  });

  it('removes operation markers before cleaning read-only history and footer context', async () => {
    const persistedBody = '<!-- kilo-review -->\nCurrent verified analysis';
    const input = incrementalInput(persistedBody);
    const publishedBody = [
      persistedBody,
      '<!-- kilo-review-history -->',
      'Archived analysis',
      '<!-- /kilo-review-history -->',
      '',
      '---',
      '<!-- kilo-usage -->',
      '<sub>Old model usage</sub>',
      `<!-- kilo-isolate-review-summary:${hashIsolateReviewText(input.previousRunId ?? '')} -->`,
    ].join('\n');
    input.existingReviewState.summaryComment = { commentId: 88, body: publishedBody };
    const result = await renderIsolateReviewPrompt(input);

    expect(result.readContextSummary).toEqual({ commentId: 88, body: 'Current verified analysis' });
    expect(result.userPrompt.split('Current verified analysis')).toHaveLength(2);
    expect(result.userPrompt).not.toContain('Archived analysis');
    expect(result.userPrompt).not.toContain('Old model usage');
    expect(result.userPrompt).not.toContain('<!-- kilo-isolate-review-summary:');
    expect(result.userPrompt).toContain('"summaryMutationTarget":null');
    expect(input.existingReviewState.summaryComment.body).toBe(publishedBody);
  });

  it('still verifies the exact persisted prior body hash rather than a marker-stripped substitute', async () => {
    const persistedBody = '<!-- kilo-review -->\nVerified previous finding';
    const input = incrementalInput(persistedBody);
    input.previousSummaryBody = `${persistedBody}\n<!-- kilo-isolate-review-summary:${'a'.repeat(64)} -->`;

    await expect(renderIsolateReviewPrompt(input)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });

  it('retains distinct current discussion context without using it as the previous analysis baseline', async () => {
    const input = incrementalInput();
    input.existingReviewState.summaryComment = {
      commentId: 88,
      body: 'Human-edited current summary',
    };
    const result = await renderIsolateReviewPrompt(input);

    expect(result.canonicalPrompt).toContain('Prior unresolved finding');
    expect(result.canonicalPrompt).not.toContain('Human-edited current summary');
    expect(result.userPrompt).toContain('Human-edited current summary');
    expect(result.userPrompt).toContain('"summaryMutationTarget":null');
  });

  it('renders a resolved full fallback without injecting previous analysis or reconsidering its mode', async () => {
    const input = incrementalInput();
    input.reviewSelection = {
      requestedMode: 'incremental',
      effectiveMode: 'full',
      previousRunId: input.previousRunId,
      fallbackReason: 'base_changed',
    };
    const result = await renderIsolateReviewPrompt(input);

    expect(result.canonicalPrompt).toBe((await canonicalPrompt(input)).prompt);
    expect(result.canonicalPrompt).toContain('# WORKFLOW');
    expect(result.canonicalPrompt).not.toContain('# INCREMENTAL REVIEW MODE');
    expect(result.userPrompt).not.toContain('Prior unresolved finding');
    expect(result.previousSummaryBody).toBeUndefined();
    expect(result.userPrompt).toContain('"effectiveMode":"full"');
    expect(result.userPrompt).toContain('"fallbackReason":"base_changed"');
  });

  it.each([undefined, '', 'Different summary', '<!-- kilo-review -->'])(
    'refuses incremental rendering without the exact nonempty persisted prior context: %j',
    async body => {
      const input = incrementalInput();
      input.previousSummaryBody = body;
      if (
        body === '<!-- kilo-review -->' &&
        input.reviewSelection.effectiveMode === 'incremental'
      ) {
        input.reviewSelection.previousSummaryHash = hashIsolateReviewText(body);
      }
      await expect(renderIsolateReviewPrompt(input)).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
    }
  );

  it('never drops configured instructions to fit the prompt', async () => {
    const input = promptInput({ custom_instructions: 'x'.repeat(64_000) });
    await expect(renderIsolateReviewPrompt(input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('not silently truncated'),
    });
  });
});
