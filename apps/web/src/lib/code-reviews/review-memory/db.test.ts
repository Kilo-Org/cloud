/* eslint-disable drizzle/enforce-delete-with-where */
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { eq } from 'drizzle-orm';
import { organizations, code_review_memory_proposals, kilocode_users } from '@kilocode/db/schema';
import type { CodeReviewMemoryProposal } from '@kilocode/db/schema';
import type { ReviewMemoryProposalStatus } from '@kilocode/db/schema-types';

import {
  isActiveProposalScopeViolation,
  markProposalChangeRequestFailed,
  markProposalOpeningChangeRequest,
  updateProposal,
  upsertScopeProposal,
  type ReviewMemoryDatabase,
  type ReviewMemoryOwner,
} from './db';

const ACTIVE_PROPOSAL_STATUSES: ReviewMemoryProposalStatus[] = [
  'open',
  'edited',
  'opening_change_request',
  'change_request_failed',
];

describe('review memory proposals', () => {
  afterEach(async () => {
    await db.delete(code_review_memory_proposals);
    await db.delete(organizations);
    await db.delete(kilocode_users);
  });

  // The status model in `db.ts` treats a failed proposal as active, and every
  // "at most one active proposal per scope" rule reads that set, so the unique
  // indexes must cover the same set. While they disagreed, a failed proposal
  // could sit beside another active one and the next save raised a unique
  // violation the caller could not interpret.
  it.each(ACTIVE_PROPOSAL_STATUSES)(
    'refuses a second %s proposal for a scope that already has one',
    async status => {
      const user = await insertTestUser();
      await insertProposal({ userId: user.id }, 'acme/widgets', 'open');

      const error = await captureError(insertProposal({ userId: user.id }, 'acme/widgets', status));

      expect(isActiveProposalScopeViolation(error)).toBe(true);
    }
  );

  it('refuses a second active proposal for an organization scope', async () => {
    const [organization] = await db
      .insert(organizations)
      .values({ name: 'Review Memory Org', stripe_customer_id: 'cus_review_memory_scope' })
      .returning();
    await insertProposal({ organizationId: organization.id }, 'acme/widgets', 'open');

    const error = await captureError(
      insertProposal({ organizationId: organization.id }, 'acme/widgets', 'change_request_failed')
    );

    expect(isActiveProposalScopeViolation(error)).toBe(true);
  });

  // The reported path: a proposal whose pull request failed is editable, and
  // saving it must persist the edits instead of failing on the scope index.
  it('saves edits to a failed proposal that owns its scope', async () => {
    const user = await insertTestUser();
    const owner: ReviewMemoryOwner = { type: 'user', id: user.id };
    const failed = await seedFailedProposal(owner, 'acme/widgets');

    const saved = await updateProposal({
      owner,
      proposalId: failed.id,
      title: 'Edited after a failed pull request',
      rationale: 'Edited rationale.',
      proposedMarkdown: 'Edited guidance.',
    });

    expect(saved).toEqual(
      expect.objectContaining({
        id: failed.id,
        status: 'edited',
        title: 'Edited after a failed pull request',
        rationale: 'Edited rationale.',
        proposed_markdown: 'Edited guidance.',
      })
    );
    const stored = await db
      .select()
      .from(code_review_memory_proposals)
      .where(eq(code_review_memory_proposals.id, failed.id));
    expect(stored[0]).toEqual(
      expect.objectContaining({ status: 'edited', title: 'Edited after a failed pull request' })
    );
  });

  it('does not save edits to another owner’s proposal', async () => {
    const user = await insertTestUser();
    const stranger = await insertTestUser();
    const failed = await seedFailedProposal({ type: 'user', id: user.id }, 'acme/widgets');

    const saved = await updateProposal({
      owner: { type: 'user', id: stranger.id },
      proposalId: failed.id,
      title: 'Hijacked',
      rationale: 'Hijacked rationale.',
      proposedMarkdown: 'Hijacked guidance.',
    });

    expect(saved).toBeNull();
  });

  // One analysis after another must leave one row: the scope's active proposal
  // is reopened and overwritten, and a failed proposal is not an exception.
  it('reopens the scope’s failed proposal instead of adding another row', async () => {
    const user = await insertTestUser();
    const owner: ReviewMemoryOwner = { type: 'user', id: user.id };
    await seedFailedProposal(owner, 'acme/widgets');

    const updated = await upsertScopeProposal({
      owner,
      platform: 'github',
      repoFullName: 'acme/widgets',
      title: 'Second analysis',
      rationale: 'Second analysis rationale.',
      proposedMarkdown: 'Second analysis guidance.',
      evidence: [],
      positiveCount: 1,
      negativeCount: 0,
      neutralCount: 0,
    });

    expect(updated).toEqual(expect.objectContaining({ status: 'open', title: 'Second analysis' }));
    const stored = await db.select().from(code_review_memory_proposals);
    expect(stored).toHaveLength(1);
  });

  // An approval can start between the analysis read and its write. The write
  // must not undo it: `opening_change_request` has to survive so the approval
  // records the pull-request URL on this row instead of opening a second one.
  it('keeps an approval that started during the analysis', async () => {
    const user = await insertTestUser();
    const owner: ReviewMemoryOwner = { type: 'user', id: user.id };
    const existing = await upsertScopeProposal({
      owner,
      platform: 'github',
      repoFullName: 'acme/widgets',
      title: 'First analysis',
      rationale: 'First rationale.',
      proposedMarkdown: 'First guidance.',
      evidence: [],
      positiveCount: 0,
      negativeCount: 0,
      neutralCount: 0,
    });

    const updated = await upsertScopeProposal({
      owner,
      platform: 'github',
      repoFullName: 'acme/widgets',
      title: 'Second analysis',
      rationale: 'Second rationale.',
      proposedMarkdown: 'Second guidance.',
      evidence: [],
      positiveCount: 0,
      negativeCount: 0,
      neutralCount: 0,
      database: interleaveAfterRead(async () => {
        await markProposalOpeningChangeRequest({ proposalId: existing.id });
      }),
    });

    expect(updated).toEqual(
      expect.objectContaining({ id: existing.id, status: 'opening_change_request' })
    );
    const stored = await db
      .select()
      .from(code_review_memory_proposals)
      .where(eq(code_review_memory_proposals.id, existing.id));
    expect(stored[0]?.status).toBe('opening_change_request');
  });
});

/**
 * The real database with `afterRead` run once between a SELECT finishing and the
 * next statement, which is where a concurrent writer lands in production.
 */
function interleaveAfterRead(afterRead: () => Promise<void>): ReviewMemoryDatabase {
  let fired = false;
  const wrap = (value: object): object =>
    new Proxy(value, {
      get(target, property, receiver) {
        const inner: unknown = Reflect.get(target, property, receiver);
        if (property === 'then' && typeof inner === 'function') {
          return (resolve: (rows: unknown) => unknown, reject: (error: unknown) => unknown) =>
            (inner as (r: unknown, j: unknown) => unknown).call(
              target,
              async (rows: unknown) => {
                if (!fired) {
                  fired = true;
                  await afterRead();
                }
                return resolve(rows);
              },
              reject
            );
        }
        if (typeof inner !== 'function') return inner;
        return (...args: unknown[]) => {
          const result: unknown = (inner as (...rest: unknown[]) => unknown).apply(target, args);
          return typeof result === 'object' && result !== null ? wrap(result) : result;
        };
      },
    });

  return new Proxy(db, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (property !== 'select' || typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const builder: unknown = (value as (...rest: unknown[]) => unknown).apply(target, args);
        return typeof builder === 'object' && builder !== null ? wrap(builder) : builder;
      };
    },
  });
}

type ProposalScope =
  | { userId: string; organizationId?: undefined }
  | { userId?: undefined; organizationId: string };

async function insertProposal(
  scope: ProposalScope,
  repoFullName: string,
  status: ReviewMemoryProposalStatus
): Promise<CodeReviewMemoryProposal> {
  const [proposal] = await db
    .insert(code_review_memory_proposals)
    .values({
      owned_by_user_id: scope.userId ?? null,
      owned_by_organization_id: scope.organizationId ?? null,
      platform: 'github',
      repo_full_name: repoFullName,
      status,
      title: `${status} proposal`,
      rationale: 'Rationale.',
      proposed_markdown: 'Guidance.',
    })
    .returning();
  return proposal;
}

async function seedFailedProposal(
  owner: ReviewMemoryOwner,
  repoFullName: string
): Promise<CodeReviewMemoryProposal> {
  const proposal = await upsertScopeProposal({
    owner,
    platform: 'github',
    repoFullName,
    title: 'Explain retry boundaries',
    rationale: 'Retrying non-idempotent work can duplicate effects.',
    proposedMarkdown: 'Check idempotency before recommending retries.',
    evidence: [],
    positiveCount: 0,
    negativeCount: 1,
    neutralCount: 0,
  });
  await markProposalOpeningChangeRequest({ proposalId: proposal.id });
  const failed = await markProposalChangeRequestFailed({ proposalId: proposal.id });
  if (!failed) throw new Error('The fixture proposal did not reach the failed status.');
  return failed;
}

/** The rejection a `database` call throws, so a test can inspect it. */
async function captureError(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error('The write was expected to be refused.');
}
