import 'server-only';

import {
  requestGitLabCredentialPrivateRepair,
  type GitLabCredentialPrivateRepairResponse,
} from './credential-private-repair-client';

export type GitLabCredentialRepairBatchResult =
  | { kind: 'ok'; batch: GitLabCredentialPrivateRepairResponse }
  | { kind: 'error'; errorCode: string; retryable: boolean };

export async function repairGitLabCustomOAuthClientSecretsBatch(input: {
  requestedByUserId: string;
  afterId: string | null;
  limit: number;
}): Promise<GitLabCredentialRepairBatchResult> {
  const response = await requestGitLabCredentialPrivateRepair(input);
  if (response.kind === 'terminal_error') {
    return { kind: 'error', errorCode: response.errorCode, retryable: false };
  }
  if (response.kind === 'retryable_error') {
    return { kind: 'error', errorCode: response.errorCode, retryable: true };
  }
  return { kind: 'ok', batch: response.repair };
}
