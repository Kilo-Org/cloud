import { TRPCError } from '@trpc/server';
import {
  normalizeRepoFullName,
  sameRepositoryIdentity,
  type EnvironmentReference,
  type EnvironmentRepositoryIdentity,
} from '@kilocode/cloud-agent-profile';
import type { SessionCreateRequest } from '../../session/session-requests.js';

/**
 * Checks the additional repositories a client named for the environment it
 * selected. Each entry must be a member of the resolved V2 environment and must
 * not be the launch repository, whose branch is `repository.branch`. A V1
 * environment has no additional repository. Every error names the repository.
 *
 * `environment` is null when no environment resolved; every entry is then a
 * non-member.
 */
export function assertRequestedRepositories(args: {
  environment: EnvironmentReference | null;
  launch: EnvironmentRepositoryIdentity | undefined;
  requested: SessionCreateRequest['requestedEnvironment'];
}): void {
  const entries = args.requested?.repositories ?? [];
  if (entries.length === 0) return;

  const members = args.environment?.repositories;
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = normalizeRepoFullName(entry.repoFullName);
    if (seen.has(key)) {
      throw badRequest(`Repository ${entry.repoFullName} is listed more than once`);
    }
    seen.add(key);

    if (members === undefined) {
      throw badRequest(
        args.environment === null
          ? `Repository ${entry.repoFullName} is not part of an environment for this session`
          : `Repository ${entry.repoFullName} cannot be added: the selected environment has a single repository`
      );
    }
    const member = members.find(candidate => normalizeRepoFullName(candidate.repoFullName) === key);
    if (member === undefined) {
      throw badRequest(
        `Repository ${entry.repoFullName} is not a member of the selected environment`
      );
    }
    if (args.launch !== undefined && sameRepositoryIdentity(member.identity, args.launch)) {
      throw badRequest(
        `Repository ${entry.repoFullName} is the launch repository; set its branch with the repository branch`
      );
    }
  }
}

function badRequest(message: string): TRPCError {
  return new TRPCError({ code: 'BAD_REQUEST', message });
}
