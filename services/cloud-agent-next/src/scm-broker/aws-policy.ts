import { STANDARD_SCM_HOSTS } from '@kilocode/worker-utils/scm-capability-contract';
import type { CredentialRepository } from '../sandbox-control/session-credentials.js';

export class AwsScmContainmentError extends Error {
  readonly reason = 'byoc_aws_scm_host_unsupported' as const;
  constructor() {
    super('AWS managed SCM requires a supported public host');
    this.name = 'AwsScmContainmentError';
  }
}
/** The immutable MVP certificate covers standard SCM hosts only. Reject before any capability issuance. */
export function assertAwsScmRepositories(
  repositories: readonly (CredentialRepository | undefined)[]
) {
  for (const repository of repositories) {
    if (repository?.type !== 'gitlab') continue;
    const url = new URL(repository.url);
    if (url.port || !STANDARD_SCM_HOSTS.includes(url.hostname)) throw new AwsScmContainmentError();
  }
}
