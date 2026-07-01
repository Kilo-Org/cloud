const mockEnsureBitbucketWorkspaceWebhookFromTokenService = jest.fn();
const mockDeleteBitbucketWorkspaceWebhooksFromTokenService = jest.fn();
let mockAppUrl = 'https://app.kilo.ai';
let mockWebhookBaseUrl = '';

jest.mock('@/lib/constants', () => ({
  get APP_URL() {
    return mockAppUrl;
  },
}));

jest.mock('@/lib/config.server', () => ({
  get BITBUCKET_CODE_REVIEW_WEBHOOK_BASE_URL() {
    return mockWebhookBaseUrl;
  },
  BITBUCKET_CODE_REVIEW_WEBHOOK_SIGNING_KEYS: JSON.stringify({
    active: Buffer.alloc(32, 7).toString('base64'),
    previous: Buffer.alloc(32, 8).toString('base64'),
  }),
}));

jest.mock('./token-service-client', () => ({
  ensureBitbucketWorkspaceWebhookFromTokenService: (...args: unknown[]) =>
    mockEnsureBitbucketWorkspaceWebhookFromTokenService(...args),
  deleteBitbucketWorkspaceWebhooksFromTokenService: (...args: unknown[]) =>
    mockDeleteBitbucketWorkspaceWebhooksFromTokenService(...args),
}));

import {
  BitbucketCodeReviewWebhookConfigurationError,
  buildBitbucketCodeReviewWebhookUrl,
  deleteBitbucketCodeReviewWorkspaceWebhooksBestEffort,
  ensureBitbucketCodeReviewWorkspaceWebhook,
} from './code-review-webhooks';
import {
  deriveBitbucketWebhookSecret,
  parseBitbucketWebhookSigningKeyring,
} from './webhook-signing';

const organizationId = '123e4567-e89b-42d3-a456-426614174030';
const workspace = {
  integrationId: '123e4567-e89b-42d3-a456-426614174000',
  workspaceUuid: 'a07d5c40-2d2d-4e79-a812-6a47824a77d6',
  workspaceSlug: 'acme',
};
const callbackUrl = `https://app.kilo.ai/api/webhooks/bitbucket/${workspace.integrationId}`;

function signingKeyring() {
  return parseBitbucketWebhookSigningKeyring(
    JSON.stringify({
      active: Buffer.alloc(32, 7).toString('base64'),
      previous: Buffer.alloc(32, 8).toString('base64'),
    })
  );
}

async function withNodeEnv<T>(nodeEnv: string, callback: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process.env, 'NODE_ENV');
  Object.defineProperty(process.env, 'NODE_ENV', {
    configurable: true,
    value: nodeEnv,
  });
  try {
    return await callback();
  } finally {
    if (descriptor) {
      Object.defineProperty(process.env, 'NODE_ENV', descriptor);
    }
  }
}

describe('stateless Bitbucket Code Reviewer workspace webhook caller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAppUrl = 'https://app.kilo.ai';
    mockWebhookBaseUrl = '';
    mockEnsureBitbucketWorkspaceWebhookFromTokenService.mockResolvedValue({
      success: true,
      webhook: {
        uuid: '00000000-0000-4000-8000-000000000001',
        callbackUrl,
        active: true,
        events: ['pullrequest:created'],
        secretSet: true,
      },
    });
    mockDeleteBitbucketWorkspaceWebhooksFromTokenService.mockResolvedValue({ success: true });
  });

  it('ensures one integration callback using typed workspace identity and the current manager', async () => {
    await expect(
      ensureBitbucketCodeReviewWorkspaceWebhook({
        organizationId,
        currentManagerId: 'manager-user',
        workspace,
      })
    ).resolves.toEqual(
      expect.objectContaining({
        success: true,
        webhook: expect.objectContaining({ callbackUrl }),
      })
    );

    expect(buildBitbucketCodeReviewWebhookUrl(workspace.integrationId)).toBe(callbackUrl);
    expect(mockEnsureBitbucketWorkspaceWebhookFromTokenService).toHaveBeenCalledTimes(1);
    expect(mockEnsureBitbucketWorkspaceWebhookFromTokenService).toHaveBeenCalledWith({
      managerUserId: 'manager-user',
      organizationId,
      workspace,
      callbackUrl,
      secret: deriveBitbucketWebhookSecret(signingKeyring().active, {
        integrationId: workspace.integrationId,
        workspaceUuid: workspace.workspaceUuid,
      }),
    });
    expect(
      JSON.stringify(mockEnsureBitbucketWorkspaceWebhookFromTokenService.mock.calls)
    ).not.toContain('repository');
  });

  it('rejects local callback origins outside tests before calling the token service', async () => {
    mockAppUrl = 'http://localhost:3000';

    await withNodeEnv('development', async () => {
      expect(() =>
        ensureBitbucketCodeReviewWorkspaceWebhook({
          organizationId,
          currentManagerId: 'manager-user',
          workspace,
        })
      ).toThrow(BitbucketCodeReviewWebhookConfigurationError);
    });

    expect(mockEnsureBitbucketWorkspaceWebhookFromTokenService).not.toHaveBeenCalled();
  });

  it('uses a dedicated public webhook base URL when configured', async () => {
    mockAppUrl = 'http://localhost:3000';
    mockWebhookBaseUrl = 'https://bitbucket-hook.example.test/';
    const expectedCallbackUrl = `https://bitbucket-hook.example.test/api/webhooks/bitbucket/${workspace.integrationId}`;

    await withNodeEnv('development', async () => {
      await expect(
        ensureBitbucketCodeReviewWorkspaceWebhook({
          organizationId,
          currentManagerId: 'manager-user',
          workspace,
        })
      ).resolves.toEqual(
        expect.objectContaining({
          success: true,
        })
      );
    });

    expect(mockEnsureBitbucketWorkspaceWebhookFromTokenService).toHaveBeenCalledWith(
      expect.objectContaining({ callbackUrl: expectedCallbackUrl })
    );
  });

  it('best-effort requests deletion of all exact callback matches without surfacing failure', async () => {
    mockDeleteBitbucketWorkspaceWebhooksFromTokenService.mockRejectedValueOnce(
      new Error('provider unavailable')
    );

    await expect(
      deleteBitbucketCodeReviewWorkspaceWebhooksBestEffort({
        organizationId,
        currentManagerId: 'manager-user',
        workspace,
      })
    ).resolves.toBeUndefined();

    expect(mockDeleteBitbucketWorkspaceWebhooksFromTokenService).toHaveBeenCalledWith({
      managerUserId: 'manager-user',
      organizationId,
      workspace,
      callbackUrl,
    });
  });
});
