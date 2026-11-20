import 'server-only';

import { captureException } from '@sentry/nextjs';
import { platform_integrations } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { and, eq, isNull, not } from 'drizzle-orm';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import type { Owner } from '@/lib/integrations/core/types';
import { createPendingIntegration } from '@/lib/integrations/db/platform-integrations';
import { ownerCondition } from '@/lib/integrations/db/predicates';
import {
  exchangeGitHubOAuthCode,
  fetchGitHubInstallationRequests,
  type GitHubInstallationRequest,
} from '@/lib/integrations/platforms/github/adapter';
import type { GitHubAppType } from '@/lib/integrations/platforms/github/app-selector';

/**
 * Outcome of matching one GitHub installation request to the owner that the
 * callback names.
 *
 * `record` writes a pending row, and `already_recorded` matches a row this
 * owner holds. `claimed_elsewhere` reports an account that another Kilo owner
 * already holds as a pending request. `unidentified` carries the reason the
 * callback cannot name one request, so the caller can report it without
 * guessing.
 */
export type InstallRequestSelection =
  | { kind: 'record'; request: GitHubInstallationRequest }
  | { kind: 'already_recorded'; request: GitHubInstallationRequest }
  | { kind: 'claimed_elsewhere'; request: GitHubInstallationRequest }
  | {
      kind: 'unidentified';
      reason: 'no_requester_identity' | 'no_outstanding_request' | 'ambiguous_request';
    };

/**
 * Picks the installation request that the callback records for one owner.
 *
 * A request whose account the owner already holds needs no write, so the
 * callback reports it as recorded. One remaining request is the request to
 * record. Two or more remaining requests leave the request unnamed.
 */
export function selectInstallRequest(params: {
  requesterRequests: readonly GitHubInstallationRequest[];
  ownerRecordedAccountIds: ReadonlySet<string>;
}): InstallRequestSelection {
  const { requesterRequests, ownerRecordedAccountIds } = params;

  const unrecordedRequests = requesterRequests.filter(
    request => !ownerRecordedAccountIds.has(request.accountId)
  );

  const [onlyUnrecorded] = unrecordedRequests;
  if (!onlyUnrecorded) {
    const [recordedRequest] = requesterRequests;
    if (!recordedRequest) return { kind: 'unidentified', reason: 'no_outstanding_request' };
    return { kind: 'already_recorded', request: recordedRequest };
  }

  if (unrecordedRequests.length === 1) return { kind: 'record', request: onlyUnrecorded };

  return { kind: 'unidentified', reason: 'ambiguous_request' };
}

/**
 * Records the pending installation request that the GitHub callback names.
 *
 * GitHub sends no request id on a `setup_action=request` callback. The OAuth
 * code names the requester, and the state row names the Kilo owner. One GitHub
 * account maps to one pending request, so the callback reports an account that
 * another owner holds as claimed elsewhere.
 */
export async function recordGitHubInstallRequest(params: {
  owner: Owner;
  githubAppType: GitHubAppType;
  code: string | null;
  kiloUser: { id: string; google_user_email: string; google_user_name: string };
}): Promise<InstallRequestSelection> {
  const { owner, githubAppType, code, kiloUser } = params;

  if (!code) return { kind: 'unidentified', reason: 'no_requester_identity' };

  let githubRequester: { id: string; login: string };
  try {
    const githubUser = await exchangeGitHubOAuthCode(code, githubAppType);
    githubRequester = { id: githubUser.id, login: githubUser.login };
  } catch (error) {
    captureException(error, {
      tags: {
        endpoint: 'github/callback',
        source: 'github_request_requester_exchange',
      },
    });
    return { kind: 'unidentified', reason: 'no_requester_identity' };
  }

  console.log('GitHub user fetched', {
    github_user_id: githubRequester.id,
    github_user_login: githubRequester.login,
  });

  const requests = await fetchGitHubInstallationRequests(githubAppType);
  const requesterRequests = requests.filter(request => request.requesterId === githubRequester.id);

  const recordedRows = await db
    .select({ accountId: platform_integrations.platform_account_id })
    .from(platform_integrations)
    .where(
      and(
        ownerCondition(owner),
        eq(platform_integrations.platform, PLATFORM.GITHUB),
        eq(platform_integrations.github_app_type, githubAppType),
        eq(platform_integrations.integration_status, INTEGRATION_STATUS.PENDING),
        isNull(platform_integrations.platform_installation_id)
      )
    );

  const ownerRecordedAccountIds = new Set<string>();
  for (const row of recordedRows) {
    if (row.accountId !== null) ownerRecordedAccountIds.add(row.accountId);
  }

  const selection = selectInstallRequest({ requesterRequests, ownerRecordedAccountIds });
  if (selection.kind !== 'record') return selection;

  const [peer] = await db
    .select({ id: platform_integrations.id })
    .from(platform_integrations)
    .where(
      and(
        not(ownerCondition(owner)),
        eq(platform_integrations.platform, PLATFORM.GITHUB),
        eq(platform_integrations.github_app_type, githubAppType),
        eq(platform_integrations.platform_account_id, selection.request.accountId),
        eq(platform_integrations.integration_status, INTEGRATION_STATUS.PENDING),
        isNull(platform_integrations.platform_installation_id)
      )
    )
    .limit(1);
  if (peer) return { kind: 'claimed_elsewhere', request: selection.request };

  await createPendingIntegration({
    organizationId: owner.type === 'org' ? owner.id : undefined,
    userId: owner.type === 'user' ? owner.id : undefined,
    requester: {
      kilo_user_id: kiloUser.id,
      kilo_user_email: kiloUser.google_user_email,
      kilo_user_name: kiloUser.google_user_name,
      requested_at: new Date().toISOString(),
    },
    githubRequester,
    githubRequest: selection.request,
    githubAppType,
  });

  return selection;
}
