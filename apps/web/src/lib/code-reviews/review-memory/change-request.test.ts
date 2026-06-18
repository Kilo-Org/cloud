/* eslint-disable drizzle/enforce-delete-with-where */
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  code_review_memory_proposals,
  kilocode_users,
  platform_integrations,
  type CodeReviewMemoryProposal,
} from '@kilocode/db/schema';

import {
  markProposalChangeRequestFailed,
  markProposalChangeRequestOpened,
  markProposalOpeningChangeRequest,
  markProposalSuperseded,
  upsertScopeProposal,
  type ReviewMemoryOwner,
} from './db';
import {
  approveAndOpenReviewMemoryChangeRequest,
  buildChangeRequestBody,
  isStaleOpeningChangeRequest,
  ReviewMemoryChangeRequestError,
  type ReviewMemoryChangeRequestOperations,
} from './change-request';
import { ReviewMemoryModelBoundaryError, type ReviewMemoryModelDiagnostics } from './llm';

const REQUEST_CORRELATION_ID = 'request-correlation-change-request';
const RAW_OUTPUT_SENTINEL = 'RAW_MODEL_OUTPUT_SECRET';
const REVIEW_MD_SENTINEL = 'EXISTING_REVIEW_MD_SECRET';
const REPOSITORY_SENTINEL = 'sensitive-owner/sensitive-repository';

describe('review memory change requests', () => {
  afterEach(async () => {
    await db.delete(code_review_memory_proposals);
    await db.delete(platform_integrations);
    await db.delete(kilocode_users);
  });

  it('builds a change-request body with the marker and proposal sections', async () => {
    const proposal = buildProposal({
      id: 'proposal-id',
      title: 'Generated fixtures',
      rationale: 'Maintainers corrected repeated generated fixture comments.',
    });

    expect(buildChangeRequestBody(proposal)).toContain(
      '<!-- kilo-review-memory-change-request -->'
    );
    expect(buildChangeRequestBody(proposal)).toContain('## Proposal');
    expect(buildChangeRequestBody(proposal)).toContain('Generated fixtures');
    expect(buildChangeRequestBody(proposal)).toContain('## Rationale');
  });

  it('applies guarded proposal status transitions', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };

    const openedProposal = await seedProposal(owner, 'acme/opened');
    const opening = await markProposalOpeningChangeRequest({ proposalId: openedProposal.id });
    expect(opening?.status).toBe('opening_change_request');
    const opened = await markProposalChangeRequestOpened({
      proposalId: openedProposal.id,
      changeRequestUrl: 'https://github.com/acme/opened/pull/1',
    });
    expect(opened).toEqual(
      expect.objectContaining({
        status: 'change_request_opened',
        change_request_url: 'https://github.com/acme/opened/pull/1',
      })
    );

    const failedProposal = await seedProposal(owner, 'acme/failed');
    await markProposalOpeningChangeRequest({ proposalId: failedProposal.id });
    const failed = await markProposalChangeRequestFailed({ proposalId: failedProposal.id });
    expect(failed?.status).toBe('change_request_failed');

    const supersededProposal = await seedProposal(owner, 'acme/superseded');
    const superseded = await markProposalSuperseded({ proposalId: supersededProposal.id });
    expect(superseded?.status).toBe('superseded');
  });

  it('detects stale opening change-request states', () => {
    const now = new Date('2026-06-01T12:00:00.000Z');

    expect(isStaleOpeningChangeRequest('2026-06-01T11:31:00.000Z', now)).toBe(false);
    expect(isStaleOpeningChangeRequest('2026-06-01T11:30:00.000Z', now)).toBe(true);
    expect(isStaleOpeningChangeRequest('not-a-date', now)).toBe(false);
  });

  it('reports a structured-output failure safely before GitHub mutations', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    const proposal = await seedProposal(owner, REPOSITORY_SENTINEL);
    await seedGitHubIntegration(owner);
    const operations = buildOperations();
    operations.fetchReviewMd.mockResolvedValue(REVIEW_MD_SENTINEL);
    const modelFailure = buildModelBoundaryError();
    Object.assign(modelFailure, {
      text: RAW_OUTPUT_SENTINEL,
      cause: new Error(`Cause containing ${RAW_OUTPUT_SENTINEL}`),
    });
    operations.integrateReviewMd.mockRejectedValue(modelFailure);

    const error = await captureError(() =>
      approveAndOpenReviewMemoryChangeRequest(
        {
          owner,
          proposalId: proposal.id,
          requestCorrelationId: REQUEST_CORRELATION_ID,
        },
        operations
      )
    );

    expect(error).toBeInstanceOf(ReviewMemoryChangeRequestError);
    expect(error).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Unable to open the REVIEW.md change request. The proposal can be retried.',
    });
    const proposals = await db.select().from(code_review_memory_proposals);
    expect(proposals).toEqual([
      expect.objectContaining({ id: proposal.id, status: 'change_request_failed' }),
    ]);
    expect(operations.createBranch).not.toHaveBeenCalled();
    expect(operations.writeReviewMd).not.toHaveBeenCalled();
    expect(operations.createPullRequest).not.toHaveBeenCalled();
    expect(operations.captureException).toHaveBeenCalledTimes(1);

    const [capturedError, captureContext] = operations.captureException.mock.calls[0];
    expect(capturedError).toEqual(
      expect.objectContaining({
        name: 'ReviewMemoryChangeRequestFailure',
        message: 'Review Memory model returned invalid structured output.',
      })
    );
    expect(captureContext).toEqual(
      expect.objectContaining({
        tags: {
          source: 'review-memory',
          operation: 'open-change-request',
          stage: 'review_md_integration',
        },
        extra: expect.objectContaining({
          requestCorrelationId: REQUEST_CORRELATION_ID,
          proposalId: proposal.id,
          providerRequestId: 'provider-request-model-failure',
          modelDiagnostics: expect.objectContaining({
            failureClassification: 'invalid_structured_output',
          }),
        }),
      })
    );
    const serializedCapture = JSON.stringify({
      name: capturedError.name,
      message: capturedError.message,
      stack: capturedError.stack,
      captureContext,
    });
    expect(serializedCapture).not.toContain(RAW_OUTPUT_SENTINEL);
    expect(serializedCapture).not.toContain(REVIEW_MD_SENTINEL);
    expect(serializedCapture).not.toContain(REPOSITORY_SENTINEL);
  });

  it('does not capture expected pre-claim domain errors', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    const proposal = await seedProposal(owner, 'acme/no-integration');
    const operations = buildOperations();

    const error = await captureError(() =>
      approveAndOpenReviewMemoryChangeRequest(
        {
          owner,
          proposalId: proposal.id,
          requestCorrelationId: REQUEST_CORRELATION_ID,
        },
        operations
      )
    );

    expect(error).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'No active GitHub integration has access to this repository.',
    });
    const proposals = await db.select().from(code_review_memory_proposals);
    expect(proposals).toEqual([expect.objectContaining({ id: proposal.id, status: 'open' })]);
    expect(operations.generateInstallationToken).not.toHaveBeenCalled();
    expect(operations.captureException).not.toHaveBeenCalled();
  });

  it('supersedes already-present guidance without GitHub mutations', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    const proposal = await seedProposal(owner, 'acme/already-present');
    await seedGitHubIntegration(owner);
    const operations = buildOperations();
    operations.integrateReviewMd.mockResolvedValue({
      status: 'already_present',
      updatedReviewMd: null,
      integrationSummary: 'Equivalent guidance already exists.',
      tokensIn: 12,
      tokensOut: 5,
    });

    const result = await approveAndOpenReviewMemoryChangeRequest(
      {
        owner,
        proposalId: proposal.id,
        requestCorrelationId: REQUEST_CORRELATION_ID,
      },
      operations
    );

    expect(result.status).toBe('superseded');
    expect(operations.createBranch).not.toHaveBeenCalled();
    expect(operations.writeReviewMd).not.toHaveBeenCalled();
    expect(operations.createPullRequest).not.toHaveBeenCalled();
    expect(operations.captureException).not.toHaveBeenCalled();
    expect(operations.log).toHaveBeenCalledWith(
      expect.stringContaining('"result":"already_present"')
    );
  });

  it('opens and persists a change request after validated model output', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    const proposal = await seedProposal(owner, 'acme/success');
    await seedGitHubIntegration(owner);
    const operations = buildOperations();

    const result = await approveAndOpenReviewMemoryChangeRequest(
      {
        owner,
        proposalId: proposal.id,
        requestCorrelationId: REQUEST_CORRELATION_ID,
      },
      operations
    );

    expect(result).toEqual(
      expect.objectContaining({
        status: 'change_request_opened',
        change_request_url: 'https://github.com/acme/widgets/pull/10',
      })
    );
    expect(operations.createBranch).toHaveBeenCalledTimes(1);
    expect(operations.writeReviewMd).toHaveBeenCalledTimes(1);
    expect(operations.createPullRequest).toHaveBeenCalledTimes(1);
    expect(operations.captureException).not.toHaveBeenCalled();
    expect(operations.log).toHaveBeenCalledWith(
      expect.stringContaining('"result":"change_request_opened"')
    );
  });

  it('retains the original failure when failure-state persistence also fails', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    const proposal = await seedProposal(owner, 'acme/persistence-failure');
    await seedGitHubIntegration(owner);
    const operations = buildOperations();
    operations.integrateReviewMd.mockRejectedValue(buildModelBoundaryError());
    const markFailed = jest.fn<
      ReturnType<ReviewMemoryChangeRequestOperations['markFailed']>,
      Parameters<ReviewMemoryChangeRequestOperations['markFailed']>
    >(async () => {
      throw new Error('database unavailable');
    });

    const error = await captureError(() =>
      approveAndOpenReviewMemoryChangeRequest(
        {
          owner,
          proposalId: proposal.id,
          requestCorrelationId: REQUEST_CORRELATION_ID,
        },
        { ...operations, markFailed }
      )
    );

    expect(error).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Unable to open the REVIEW.md change request. The proposal can be retried.',
    });
    expect(operations.captureException).toHaveBeenCalledTimes(2);
    expect(operations.captureException.mock.calls[0]?.[1].tags.stage).toBe('review_md_integration');
    expect(operations.captureException.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        tags: expect.objectContaining({ stage: 'failure_persistence' }),
        extra: expect.objectContaining({ failedAtStage: 'review_md_integration' }),
      })
    );
  });
});

function buildProposal(input: {
  id: string;
  title: string;
  rationale: string;
}): CodeReviewMemoryProposal {
  return {
    id: input.id,
    owned_by_organization_id: null,
    owned_by_user_id: 'user-id',
    platform: 'github',
    repo_full_name: 'acme/widgets',
    status: 'open',
    title: input.title,
    rationale: input.rationale,
    proposed_markdown: '## Generated fixtures\n\nDo not flag generated fixtures.',
    evidence: [],
    positive_count: 0,
    negative_count: 0,
    neutral_count: 0,
    change_request_url: null,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
  };
}

async function seedProposal(owner: ReviewMemoryOwner, repoFullName: string) {
  return await upsertScopeProposal({
    owner,
    platform: 'github',
    repoFullName,
    title: 'Generated fixtures',
    rationale: 'Maintainers corrected repeated generated fixture comments.',
    proposedMarkdown: '## Generated fixtures\n\nDo not flag generated fixtures.',
    evidence: [{ excerpt: 'Generated fixture feedback.', prNumber: 10 }],
    positiveCount: 0,
    negativeCount: 1,
    neutralCount: 0,
  });
}

async function seedGitHubIntegration(owner: ReviewMemoryOwner): Promise<void> {
  if (owner.type !== 'user') throw new Error('Test helper requires a user owner.');
  await db.insert(platform_integrations).values({
    owned_by_user_id: owner.id,
    owned_by_organization_id: null,
    platform: 'github',
    integration_type: 'app',
    platform_installation_id: 'installation-id',
    github_app_type: 'standard',
    integration_status: 'active',
    repository_access: 'all',
    permissions: {
      contents: 'write',
      pull_requests: 'write',
    },
  });
}

function buildOperations() {
  const fetchReviewMd = jest.fn<
    ReturnType<ReviewMemoryChangeRequestOperations['fetchReviewMd']>,
    Parameters<ReviewMemoryChangeRequestOperations['fetchReviewMd']>
  >(async () => null);
  const integrateReviewMd = jest.fn<
    ReturnType<ReviewMemoryChangeRequestOperations['integrateReviewMd']>,
    Parameters<ReviewMemoryChangeRequestOperations['integrateReviewMd']>
  >(async () => ({
    status: 'updated',
    updatedReviewMd: '# Code review\n\nCheck generated fixtures against their source.',
    integrationSummary: 'Added generated fixture guidance.',
    tokensIn: 12,
    tokensOut: 5,
  }));

  return {
    generateInstallationToken: jest.fn(async () => ({
      token: 'installation-token',
      expires_at: '2099-01-01T00:00:00.000Z',
    })),
    fetchDefaultBranch: jest.fn(async () => 'main'),
    fetchReviewMd,
    integrateReviewMd,
    createBranch: jest.fn(async () => undefined),
    writeReviewMd: jest.fn(async () => undefined),
    createPullRequest: jest.fn(async () => ({
      number: 10,
      url: 'https://github.com/acme/widgets/pull/10',
    })),
    markFailed: markProposalChangeRequestFailed,
    log: jest.fn(),
    captureException: jest.fn<
      ReturnType<ReviewMemoryChangeRequestOperations['captureException']>,
      Parameters<ReviewMemoryChangeRequestOperations['captureException']>
    >(),
  } satisfies ReviewMemoryChangeRequestOperations;
}

function buildModelBoundaryError(): ReviewMemoryModelBoundaryError {
  const diagnostics: ReviewMemoryModelDiagnostics = {
    operation: 'review_md_integration',
    stage: 'structured_output_validation',
    outcome: 'failure',
    requestCorrelationId: REQUEST_CORRELATION_ID,
    modelSlug: 'test/model',
    finishReason: 'stop',
    rawFinishReason: 'stop',
    generatedTextCharacterCount: 120,
    structuredParseCandidateCharacterCount: 120,
    inputTokens: 12,
    outputTokens: 5,
    totalTokens: 17,
    providerRequestId: 'provider-request-model-failure',
    responseId: 'response-model-failure',
    failureClassification: 'invalid_structured_output',
    errorClass: 'NoObjectGeneratedError',
    errorMessage: 'Review Memory model returned invalid structured output.',
  };
  return new ReviewMemoryModelBoundaryError(diagnostics);
}

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to reject.');
}
