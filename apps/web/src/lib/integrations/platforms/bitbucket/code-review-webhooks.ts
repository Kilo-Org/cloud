import 'server-only';

import { z } from 'zod';
import {
  BITBUCKET_CODE_REVIEW_WEBHOOK_BASE_URL,
  BITBUCKET_CODE_REVIEW_WEBHOOK_SIGNING_KEYS,
} from '@/lib/config.server';
import { APP_URL } from '@/lib/constants';
import {
  deleteBitbucketWorkspaceWebhooksFromTokenService,
  ensureBitbucketWorkspaceWebhookFromTokenService,
  type BitbucketCodeReviewWorkspaceIdentity,
  type BitbucketEnsureWebhookResult,
} from './token-service-client';
import {
  deriveBitbucketWebhookSecret,
  parseBitbucketWebhookSigningKeyring,
} from './webhook-signing';

export type BitbucketCodeReviewWebhookWorkspace = BitbucketCodeReviewWorkspaceIdentity;

type BitbucketCodeReviewWorkspaceWebhookInput = {
  organizationId: string;
  currentManagerId: string;
  workspace: BitbucketCodeReviewWebhookWorkspace;
};

export type BitbucketCodeReviewWebhookConfigurationErrorCode =
  | 'signing_configuration_invalid'
  | 'callback_origin_invalid';

export class BitbucketCodeReviewWebhookConfigurationError extends Error {
  constructor(readonly code: BitbucketCodeReviewWebhookConfigurationErrorCode) {
    super(code);
    this.name = 'BitbucketCodeReviewWebhookConfigurationError';
  }
}

function callbackOrigin(): string {
  const baseUrl = BITBUCKET_CODE_REVIEW_WEBHOOK_BASE_URL || APP_URL;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new BitbucketCodeReviewWebhookConfigurationError('callback_origin_invalid');
  }
  const isLocalhost =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  const isTest = process.env.NODE_ENV === 'test';
  if (
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    (!isTest && (url.protocol !== 'https:' || url.port !== '' || isLocalhost))
  ) {
    throw new BitbucketCodeReviewWebhookConfigurationError('callback_origin_invalid');
  }
  return url.origin;
}

export function buildBitbucketCodeReviewWebhookUrl(integrationId: string): string {
  const parsedIntegrationId = z.string().uuid().safeParse(integrationId);
  if (!parsedIntegrationId.success) {
    throw new BitbucketCodeReviewWebhookConfigurationError('callback_origin_invalid');
  }
  return `${callbackOrigin()}/api/webhooks/bitbucket/${parsedIntegrationId.data}`;
}

function activeSigningKey(): Uint8Array {
  try {
    return parseBitbucketWebhookSigningKeyring(BITBUCKET_CODE_REVIEW_WEBHOOK_SIGNING_KEYS).active;
  } catch {
    throw new BitbucketCodeReviewWebhookConfigurationError('signing_configuration_invalid');
  }
}

export function ensureBitbucketCodeReviewWorkspaceWebhook(
  input: BitbucketCodeReviewWorkspaceWebhookInput
): Promise<BitbucketEnsureWebhookResult> {
  const callbackUrl = buildBitbucketCodeReviewWebhookUrl(input.workspace.integrationId);
  const secret = deriveBitbucketWebhookSecret(activeSigningKey(), {
    integrationId: input.workspace.integrationId,
    workspaceUuid: input.workspace.workspaceUuid,
  });
  return ensureBitbucketWorkspaceWebhookFromTokenService({
    managerUserId: input.currentManagerId,
    organizationId: input.organizationId,
    workspace: input.workspace,
    callbackUrl,
    secret,
  });
}

export async function deleteBitbucketCodeReviewWorkspaceWebhooksBestEffort(
  input: BitbucketCodeReviewWorkspaceWebhookInput
): Promise<void> {
  try {
    await deleteBitbucketWorkspaceWebhooksFromTokenService({
      managerUserId: input.currentManagerId,
      organizationId: input.organizationId,
      workspace: input.workspace,
      callbackUrl: buildBitbucketCodeReviewWebhookUrl(input.workspace.integrationId),
    });
  } catch {
    return;
  }
}
