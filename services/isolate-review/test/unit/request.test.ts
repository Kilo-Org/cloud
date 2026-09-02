import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  notifyQueuedReview,
  requestQueuedAuthority,
  type QueuedReviewState,
} from '../../src/queued-review';
import {
  MAX_REVIEW_PROMPT_CHARACTERS,
  StartReviewRequestSchema,
  preparationMatchesIdentity,
  type IsolateReviewPreparation,
  type IsolateReviewInference,
  type IsolateReviewSelection,
} from '../../src/types';

const validRequest = {
  owner: 'acme',
  repo: 'widget',
  pullNumber: 42,
  dryRun: true,
};

const boundedStringFields = [
  ['owner', 100],
  ['repo', 100],
  ['gitToken', 8_192],
  ['organizationId', 256],
  ['headSha', 64],
  ['baseTipSha', 64],
  ['mergeBaseSha', 64],
  ['model', 512],
  ['expectedIntegrationId', 256],
  ['expectedInstallationId', 256],
  ['previousRunId', 256],
] as const;

const inference: IsolateReviewInference = {
  modelId: 'openai/review-model',
  provider: 'openai',
  thinkingEffort: 'xhigh',
  variant: { reasoning: { effort: 'xhigh' }, verbosity: 'high' },
  reasoningSupported: true,
  maxOutputTokens: 16_000,
};
const preparation: IsolateReviewPreparation = {
  version: 1,
  preparedAt: '2026-08-27T09:00:00.000Z',
  requestingUserId: 'oauth/human',
  executionUserId: 'review-bot',
  organizationId: 'org-1',
  settings: {
    reviewStyle: 'balanced',
    focusAreas: ['correctness'],
    customInstructions: null,
    manualInstructions: null,
    model: inference.modelId,
    thinkingEffort: inference.thinkingEffort,
    modelSource: 'explicit',
    disableReviewMd: true,
    analyticsEnabled: false,
  },
  snapshot: { headSha: 'a'.repeat(40), baseTipSha: 'b'.repeat(40), mergeBaseSha: 'c'.repeat(40) },
  github: { integrationId: 'integration-1', installationId: 'installation-1', appType: 'standard' },
  hashes: {
    settings: 'd'.repeat(64),
    context: 'e'.repeat(64),
    canonicalPrompt: 'f'.repeat(64),
    adaptedPrompt: '1'.repeat(64),
    system: '2'.repeat(64),
  },
  versions: { cli: '7.4.20', policy: '1', adapter: '1' },
  limitations: [],
};
const preparedRequest = {
  ...validRequest,
  ...preparation.snapshot,
  organizationId: 'org-1',
  model: inference.modelId,
  thinkingEffort: inference.thinkingEffort,
  inference,
  preparation,
  userPrompt: 'Complete canonical prepared prompt',
  expectedIntegrationId: preparation.github.integrationId,
  expectedInstallationId: preparation.github.installationId,
  expectedAppType: preparation.github.appType,
};

const previousRunId = 'c4a13e6e-8e72-4e98-b0cf-ff3b717d914d';
const incrementalSelection = {
  requestedMode: 'incremental',
  effectiveMode: 'incremental',
  previousRunId,
  previousHeadSha: '3'.repeat(40),
  previousSummaryHash: '4'.repeat(64),
  changedFileCount: 1,
} satisfies IsolateReviewSelection;
const incrementalRequest = {
  ...preparedRequest,
  reviewMode: 'incremental',
  previousRunId,
  preparation: { ...preparation, reviewSelection: incrementalSelection },
};
const fallbackSelection = {
  requestedMode: 'incremental',
  effectiveMode: 'full',
  previousRunId,
  fallbackReason: 'previous_summary_unavailable',
} satisfies IsolateReviewSelection;

describe('isolate-review request schema', () => {
  it('accepts the public request fields without credentials', () => {
    expect(StartReviewRequestSchema.safeParse(validRequest).success).toBe(true);
  });

  it('rejects credentials that must come from authentication', () => {
    expect(StartReviewRequestSchema.safeParse({ ...validRequest, kiloToken: 'jwt' }).success).toBe(
      false
    );
    expect(StartReviewRequestSchema.safeParse({ ...validRequest, userId: 'user-1' }).success).toBe(
      false
    );
  });

  it('rejects a caller-supplied credential expiry', () => {
    expect(
      StartReviewRequestSchema.safeParse({
        ...validRequest,
        credentialsExpireAt: Date.now() + 60_000,
      }).success
    ).toBe(false);
  });

  it('preserves prepared settings, immutable snapshot, and separately resolved inference', () => {
    expect(StartReviewRequestSchema.parse(preparedRequest)).toEqual(preparedRequest);
    expect(preparationMatchesIdentity(preparedRequest, 'review-bot')).toBe(true);
    expect(preparationMatchesIdentity(preparedRequest, 'oauth/human')).toBe(false);
    expect(
      preparationMatchesIdentity(
        {
          ...preparedRequest,
          organizationId: undefined,
          preparation: { ...preparation, organizationId: undefined },
        },
        'review-bot'
      )
    ).toBe(false);
  });

  it.each([0, 299])(
    'preserves canonical incremental selection with %s changed files and no summary target',
    changedFileCount => {
      const request = {
        ...incrementalRequest,
        preparation: {
          ...preparation,
          reviewSelection: { ...incrementalSelection, changedFileCount },
        },
      };
      expect(StartReviewRequestSchema.parse(request)).toEqual(request);
      expect(request).not.toHaveProperty('existingSummaryCommentId');
    }
  );

  it('preserves an explicit prepared full fallback without active incremental fields', () => {
    const request = {
      ...incrementalRequest,
      preparation: { ...preparation, reviewSelection: fallbackSelection },
    };
    expect(StartReviewRequestSchema.parse(request)).toEqual(request);
  });

  it.each([undefined, 'full'])(
    'keeps full-review and legacy previous-run requests valid: %s',
    reviewMode => {
      const request = { ...validRequest, reviewMode, previousRunId: 'legacy-prior-run' };
      expect(StartReviewRequestSchema.parse(request)).toEqual(request);
      const prepared = {
        ...preparedRequest,
        reviewMode,
        preparation: {
          ...preparation,
          reviewSelection: { requestedMode: 'full', effectiveMode: 'full' },
        },
      };
      expect(StartReviewRequestSchema.parse(prepared)).toEqual(prepared);
    }
  );

  it.each([
    { label: 'raw incremental request', override: { preparation: undefined } },
    { label: 'unselected preparation', override: { preparation } },
    { label: 'missing previous run', override: { previousRunId: undefined } },
    { label: 'non-UUID previous run', override: { previousRunId: 'legacy-prior-run' } },
    { label: 'omitted incremental mode', override: { reviewMode: undefined } },
    { label: 'mismatched mode', override: { reviewMode: 'full' } },
    { label: 'unsupported mode', override: { reviewMode: 'automatic' } },
    {
      label: 'mismatched previous run',
      override: { previousRunId: 'b7054d96-effa-45bc-a633-7de6957444a7' },
    },
  ])('rejects $label instead of accepting an unprepared selection', ({ override }) => {
    expect(StartReviewRequestSchema.safeParse({ ...incrementalRequest, ...override }).success).toBe(
      false
    );
  });

  it.each([
    { requestedMode: 'full' },
    { previousRunId: 'legacy-prior-run' },
    { previousHeadSha: 'abc123' },
    { previousHeadSha: undefined },
    { previousSummaryHash: '4'.repeat(63) },
    { previousSummaryHash: undefined },
    { changedFileCount: -1 },
    { changedFileCount: 0.5 },
    { changedFileCount: 300 },
    { changedFileCount: '1' },
    { changedFileCount: undefined },
    { fallbackReason: 'comparison_unavailable' },
  ])('rejects malformed or contradictory effective incremental selection: %j', override => {
    expect(
      StartReviewRequestSchema.safeParse({
        ...incrementalRequest,
        preparation: {
          ...preparation,
          reviewSelection: { ...incrementalSelection, ...override },
        },
      }).success
    ).toBe(false);
  });

  it.each([
    { fallbackReason: undefined },
    { fallbackReason: 'unrecognized_reason' },
    { previousRunId: undefined },
    { previousHeadSha: incrementalSelection.previousHeadSha },
    { previousSummaryHash: incrementalSelection.previousSummaryHash },
    { changedFileCount: 1 },
  ])('rejects incomplete full fallbacks or active incremental fields: %j', override => {
    expect(
      StartReviewRequestSchema.safeParse({
        ...incrementalRequest,
        preparation: {
          ...preparation,
          reviewSelection: { ...fallbackSelection, ...override },
        },
      }).success
    ).toBe(false);
  });

  it.each([
    { reviewSelection: incrementalSelection },
    { summaryContent: { body: 'Forged analysis', bodyHash: '4'.repeat(64) } },
    { historyState: { requestCount: 0, commitShas: [incrementalSelection.previousHeadSha] } },
  ])('rejects caller-supplied retained worker state', override => {
    expect(StartReviewRequestSchema.safeParse({ ...incrementalRequest, ...override }).success).toBe(
      false
    );
  });

  it('allows prepared inference to be resolved during authenticated admission when omitted', () => {
    const request = { ...preparedRequest, inference: undefined };
    expect(StartReviewRequestSchema.parse(request)).toEqual(request);
  });

  it.each([undefined, '', ' ', 'a'.repeat(MAX_REVIEW_PROMPT_CHARACTERS + 1)])(
    'rejects an absent or oversized prepared prompt',
    userPrompt => {
      expect(StartReviewRequestSchema.safeParse({ ...preparedRequest, userPrompt }).success).toBe(
        false
      );
    }
  );

  it.each([
    { model: 'another-model' },
    { thinkingEffort: null },
    { headSha: 'd'.repeat(40) },
    { baseTipSha: 'd'.repeat(40) },
    { mergeBaseSha: 'd'.repeat(40) },
    { organizationId: 'other-org' },
    { expectedIntegrationId: 'other-integration' },
    { expectedInstallationId: 'other-installation' },
    { expectedAppType: 'lite' },
  ])('rejects inconsistent prepared contract fields: %j', override => {
    expect(StartReviewRequestSchema.safeParse({ ...preparedRequest, ...override }).success).toBe(
      false
    );
  });

  it.each([
    { ...inference, provider: 'unsupported' },
    { ...inference, maxOutputTokens: 0 },
    { ...inference, maxOutputTokens: 1_000_001 },
    { ...inference, variant: { reasoning: { effort: 'thinking' } } },
    { ...inference, variant: { reasoning: { enabled: true, tokenBudget: 100 } } },
    { ...inference, baseUrl: 'https://untrusted.test' },
  ])('rejects unsafe or unbounded inference options', value => {
    expect(
      StartReviewRequestSchema.safeParse({ ...preparedRequest, inference: value }).success
    ).toBe(false);
  });

  it.each([{ temperature: 0, topP: 0 }, { temperature: 0.55, topP: 1 }, { temperature: 2 }])(
    'preserves bounded optional inference sampling',
    sampling => {
      const request = { ...preparedRequest, inference: { ...inference, ...sampling } };
      expect(StartReviewRequestSchema.parse(request)).toEqual(request);
      expect(StartReviewRequestSchema.parse(preparedRequest).inference).not.toHaveProperty(
        'temperature'
      );
      expect(StartReviewRequestSchema.parse(preparedRequest).inference).not.toHaveProperty('topP');
    }
  );

  it.each([
    { temperature: -0.01 },
    { temperature: 2.01 },
    { topP: -0.01 },
    { topP: 1.01 },
    { temperature: NaN },
    { topP: Infinity },
    { temperature: '0.55' },
    { topP: null },
  ])('rejects invalid inference sampling', sampling => {
    expect(
      StartReviewRequestSchema.safeParse({
        ...preparedRequest,
        inference: { ...inference, ...sampling },
      }).success
    ).toBe(false);
  });

  it.each(['reviewReconciliationAttempts', 'summaryReconciliationAttempts'])(
    'rejects caller-supplied %s',
    key => {
      expect(StartReviewRequestSchema.safeParse({ ...validRequest, [key]: 0 }).success).toBe(false);
    }
  );

  it.each([4_000, 4_001])('bounds prepared manual instructions to 4000 characters: %s', length => {
    const request = {
      ...preparedRequest,
      preparation: {
        ...preparation,
        settings: { ...preparation.settings, manualInstructions: 'x'.repeat(length) },
      },
    };
    expect(StartReviewRequestSchema.safeParse(request).success).toBe(length === 4_000);
  });

  it('allows saved settings that fit the prompt budget without narrower incidental field caps', () => {
    const settings = {
      ...preparation.settings,
      customInstructions: 'x'.repeat(20_000),
      focusAreas: [...Array.from({ length: 200 }, () => 'correctness'), 'context'.repeat(500)],
    };
    const request = {
      ...preparedRequest,
      userPrompt: `${settings.customInstructions}\n${settings.focusAreas.join(', ')}`,
      preparation: { ...preparation, settings },
    };
    expect(StartReviewRequestSchema.parse(request)).toEqual(request);
    expect(
      StartReviewRequestSchema.safeParse({
        ...request,
        preparation: {
          ...preparation,
          settings: { ...settings, focusAreas: ['x'.repeat(32_000), 'y'.repeat(32_000)] },
        },
      }).success
    ).toBe(false);
    expect(
      StartReviewRequestSchema.safeParse({
        ...request,
        preparation: {
          ...preparation,
          settings: { ...settings, customInstructions: 'x'.repeat(64_001) },
        },
      }).success
    ).toBe(false);
  });

  it('rejects extra provenance keys and a duplicate inference copy in the manifest', () => {
    expect(
      StartReviewRequestSchema.safeParse({
        ...preparedRequest,
        preparation: { ...preparation, inference },
      }).success
    ).toBe(false);
    expect(
      StartReviewRequestSchema.safeParse({
        ...preparedRequest,
        preparation: { ...preparation, github: { ...preparation.github, token: 'secret' } },
      }).success
    ).toBe(false);
  });

  it.each([null, 'none', 'instant', 'thinking', 'xhigh', 'max', 'a'.repeat(50)])(
    'preserves explicit nullable effort keys: %s',
    thinkingEffort => {
      const value = { ...validRequest, model: 'model', thinkingEffort };
      expect(StartReviewRequestSchema.parse(value)).toEqual(value);
      expect(StartReviewRequestSchema.safeParse({ ...validRequest, thinkingEffort }).success).toBe(
        false
      );
    }
  );

  it('rejects effort keys longer than 50 characters', () => {
    expect(
      StartReviewRequestSchema.safeParse({
        ...validRequest,
        model: 'model',
        thinkingEffort: 'a'.repeat(51),
      }).success
    ).toBe(false);
  });

  it('rejects invalid field types before the Durable Object is started', () => {
    expect(StartReviewRequestSchema.safeParse({ ...validRequest, pullNumber: '42' }).success).toBe(
      false
    );
    expect(StartReviewRequestSchema.safeParse({ ...validRequest, dryRun: 'false' }).success).toBe(
      false
    );
  });

  it.each(boundedStringFields)('accepts %s at the maximum length', (field, maximum) => {
    expect(
      StartReviewRequestSchema.safeParse({ ...validRequest, [field]: 'a'.repeat(maximum) }).success
    ).toBe(true);
  });

  it.each(boundedStringFields)('rejects %s exceeding the maximum length', (field, maximum) => {
    expect(
      StartReviewRequestSchema.safeParse({ ...validRequest, [field]: 'a'.repeat(maximum + 1) })
        .success
    ).toBe(false);
  });

  it('accepts a user prompt at the maximum length', () => {
    const userPrompt = 'a'.repeat(MAX_REVIEW_PROMPT_CHARACTERS);

    expect(StartReviewRequestSchema.safeParse({ ...validRequest, userPrompt }).success).toBe(true);
  });

  it('rejects a user prompt exceeding the maximum length', () => {
    const userPrompt = 'a'.repeat(MAX_REVIEW_PROMPT_CHARACTERS + 1);

    expect(StartReviewRequestSchema.safeParse({ ...validRequest, userPrompt }).success).toBe(false);
  });
});

describe('queued review callback requests', () => {
  afterEach(() => vi.restoreAllMocks());

  function fixture(): QueuedReviewState {
    const identity = {
      reviewId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      generation: crypto.randomUUID(),
      organizationId: crypto.randomUUID(),
      integrationId: crypto.randomUUID(),
      executionUserId: 'review-bot',
      target: { host: 'github.com' as const, repoFullName: 'acme/widget', prNumber: 42 },
      snapshot: preparation.snapshot,
    };
    const safety = {
      sequence: 1,
      execution: 'running' as const,
      cancellationRequested: false,
      publication: 'not_started' as const,
      quiescent: false,
      observedAt: '2026-09-02T00:00:00.000Z',
    };
    return {
      identity,
      preparationHash: 'a'.repeat(64),
      callback: { url: 'https://callback.offline.invalid/status', token: 'b'.repeat(64) },
      maintenanceScheduleId: 'maintenance',
      admitted: true,
      cancellationRequested: false,
      operations: [],
      safety,
      fenceReleased: false,
      pendingNotification: { version: 1, identity, safety },
      acknowledgedSequence: 0,
      cleaned: false,
    };
  }

  it.each(['execute', 'publish', 'reconcile'] as const)(
    'uses supported no-follow semantics for %s authority',
    async operation => {
      const queued = fixture();
      const operationId = crypto.randomUUID();
      const body = {
        version: 1,
        identity: queued.identity,
        operation,
        operationId,
        preparationHash: queued.preparationHash,
      };
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const request = new Request(input, init);
        expect(request.url).toBe(queued.callback.url);
        expect(request.method).toBe('POST');
        expect(request.redirect).toBe('manual');
        expect(request.headers.get('X-Callback-Token')).toBe(queued.callback.token);
        expect(await request.json()).toEqual(body);
        return Response.json({
          ...body,
          authorized: true,
          ...(operation === 'reconcile' ? { reconciliationUserId: 'review-bot' } : {}),
        });
      });

      await expect(requestQueuedAuthority(queued, operation, operationId)).resolves.toBe(true);
      expect(fetch).toHaveBeenCalledOnce();
    }
  );

  it('uses supported no-follow semantics for notifications', async () => {
    const queued = fixture();
    const acknowledgement = {
      version: 1,
      identity: queued.identity,
      sequence: queued.safety.sequence,
      notificationRecorded: true,
      fenceReleased: false,
      usageSettled: false,
    };
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe(queued.callback.url);
      expect(request.redirect).toBe('manual');
      expect(request.headers.get('X-Callback-Token')).toBe(queued.callback.token);
      expect(await request.json()).toEqual(queued.pendingNotification);
      return Response.json(acknowledgement);
    });

    await expect(notifyQueuedReview(queued)).resolves.toEqual(acknowledgement);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([301, 302, 303, 307, 308])(
    'rejects %s without following Location or accepting redirected callback data',
    async status => {
      for (const operation of ['execute', 'notify'] as const) {
        const queued = fixture();
        const cancel = vi.fn();
        const response = new Response(new ReadableStream({ cancel }), {
          status,
          headers: { Location: 'https://redirect.offline.invalid/credentials' },
        });
        const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
          expect(input).toBe(queued.callback.url);
          expect(init?.redirect).toBe('manual');
          return response;
        });
        const result =
          operation === 'execute'
            ? requestQueuedAuthority(queued, 'execute', crypto.randomUUID())
            : notifyQueuedReview(queued);

        await expect(result).rejects.toThrow('Queued review callback unavailable');
        expect(cancel).toHaveBeenCalledOnce();
        expect(fetch).toHaveBeenCalledOnce();
        fetch.mockRestore();
      }
    }
  );
});
