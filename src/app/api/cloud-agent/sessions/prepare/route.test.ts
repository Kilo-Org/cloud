import { describe, test, expect, beforeEach } from '@jest/globals';
import { NextResponse } from 'next/server';
import { POST } from './route';
import { failureResult } from '@/lib/maybe-result';
import { getUserFromAuth } from '@/lib/user.server';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import {
  validateGitHubRepoAccessForUser,
  validateGitHubRepoAccessForOrganization,
  getGitHubInstallationIdForUser,
  getGitHubInstallationIdForOrganization,
} from '@/lib/cloud-agent/github-integration-helpers';
import { createCloudAgentClient } from '@/lib/cloud-agent/cloud-agent-client';
import { signStreamTicket } from '@/lib/cloud-agent/stream-ticket';
import {
  mergeProfileConfiguration,
  ProfileNotFoundError,
  type MergeProfileConfigurationResult,
} from '@/lib/agent/profile-session-config';
import type { User } from '@/db/schema';

jest.mock('@/lib/user.server');
jest.mock('@/routers/organizations/utils');
jest.mock('@/lib/cloud-agent/github-integration-helpers');
jest.mock('@/lib/cloud-agent/cloud-agent-client');
jest.mock('@/lib/cloud-agent/stream-ticket');
jest.mock('@/lib/agent/profile-session-config', () => ({
  mergeProfileConfiguration: jest.fn(),
  ProfileNotFoundError: class ProfileNotFoundError extends Error {},
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedEnsureOrganizationAccess = jest.mocked(ensureOrganizationAccess);
const mockedGetGitHubInstallationIdForUser = jest.mocked(getGitHubInstallationIdForUser);
const mockedGetGitHubInstallationIdForOrganization = jest.mocked(
  getGitHubInstallationIdForOrganization
);
const mockedValidateGitHubRepoAccessForUser = jest.mocked(validateGitHubRepoAccessForUser);
const mockedValidateGitHubRepoAccessForOrganization = jest.mocked(
  validateGitHubRepoAccessForOrganization
);
const mockedCreateCloudAgentClient = jest.mocked(createCloudAgentClient);
const mockedSignStreamTicket = jest.mocked(signStreamTicket);
const mockedMergeProfileConfiguration = jest.mocked(mergeProfileConfiguration);

function makeRequest(body: unknown) {
  return new Request('http://localhost:3000/api/cloud-agent/sessions/prepare', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function makeInvalidJsonRequest() {
  return new Request('http://localhost:3000/api/cloud-agent/sessions/prepare', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: 'not valid json',
  });
}

const validInput = {
  prompt: 'Add a hello world function',
  mode: 'code',
  model: 'anthropic/claude-3-5-sonnet',
  githubRepo: 'owner/repo',
};

function createMockUser(overrides: Partial<User> = {}): User {
  return {
    id: crypto.randomUUID(),
    google_user_email: `test-${Date.now()}@example.com`,
    google_user_name: 'Test User',
    google_user_image_url: 'https://example.com/avatar.png',
    hosted_domain: 'example.com',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    is_admin: false,
    blocked_reason: null,
    api_token_pepper: 'test-pepper',
    auto_top_up_enabled: false,
    stripe_customer_id: 'cus_test123',
    microdollars_used: 0,
    kilo_pass_threshold: null,
    total_microdollars_acquired: 0,
    next_credit_expiration_at: null,
    has_validation_stytch: null,
    has_validation_novel_card_with_hold: false,
    default_model: null,
    is_bot: false,
    cohorts: {},
    completed_welcome_form: false,
    linkedin_url: null,
    github_url: null,
    ...overrides,
  };
}

function createMockCloudAgentClient(
  prepareSession: jest.Mock = jest.fn()
): ReturnType<typeof createCloudAgentClient> {
  return { prepareSession } as unknown as ReturnType<typeof createCloudAgentClient>;
}

function setUserAuth(overrides: Partial<User> = {}) {
  const user = createMockUser(overrides);
  mockedGetUserFromAuth.mockResolvedValue({
    user,
    authFailedResponse: null,
  });
  return user;
}

describe('POST /api/cloud-agent/sessions/prepare', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedValidateGitHubRepoAccessForUser.mockResolvedValue(true);
    mockedValidateGitHubRepoAccessForOrganization.mockResolvedValue(true);
    mockedMergeProfileConfiguration.mockResolvedValue({
      envVars: undefined,
      setupCommands: undefined,
      encryptedSecrets: undefined,
    });
    mockedSignStreamTicket.mockReturnValue({ ticket: 'test-ticket', expiresAt: 1234567890 });
  });

  describe('authentication', () => {
    test('returns authFailedResponse when auth fails', async () => {
      const authFailedResponse = NextResponse.json(failureResult('Unauthorized'), { status: 401 });

      mockedGetUserFromAuth.mockResolvedValue({
        user: null,
        authFailedResponse,
      });

      const response = await POST(makeRequest(validInput));

      expect(response).toBe(authFailedResponse);
    });
  });

  describe('request validation', () => {
    test('returns 400 for invalid JSON', async () => {
      setUserAuth();

      const response = await POST(makeInvalidJsonRequest());

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Invalid JSON in request body');
    });

    test('returns 400 when prompt is missing', async () => {
      setUserAuth();

      const response = await POST(
        makeRequest({
          mode: 'code',
          model: 'anthropic/claude-3-5-sonnet',
          githubRepo: 'owner/repo',
        })
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Invalid request');
      expect(body.details).toContainEqual(expect.objectContaining({ path: 'prompt' }));
    });

    test('returns 400 when mode is invalid', async () => {
      setUserAuth();

      const response = await POST(
        makeRequest({
          ...validInput,
          mode: 'invalid-mode',
        })
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Invalid request');
      expect(body.details).toContainEqual(expect.objectContaining({ path: 'mode' }));
    });

    test('returns 400 when githubRepo format is invalid', async () => {
      setUserAuth();

      const response = await POST(
        makeRequest({
          ...validInput,
          githubRepo: 'invalid-repo-format',
        })
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Invalid request');
      expect(body.details).toContainEqual(
        expect.objectContaining({
          path: 'githubRepo',
          message: expect.stringContaining('owner/repo'),
        })
      );
    });

    test('returns 400 when organizationId is not a valid UUID', async () => {
      setUserAuth();

      const response = await POST(
        makeRequest({
          ...validInput,
          organizationId: 'not-a-uuid',
        })
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Invalid request');
      expect(body.details).toContainEqual(expect.objectContaining({ path: 'organizationId' }));
    });

    test('returns 400 when envVars exceeds limit', async () => {
      setUserAuth();

      const tooManyEnvVars: Record<string, string> = {};
      for (let i = 0; i < 51; i++) {
        tooManyEnvVars[`VAR_${i}`] = 'value';
      }

      const response = await POST(
        makeRequest({
          ...validInput,
          envVars: tooManyEnvVars,
        })
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Invalid request');
      expect(body.details).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining('50'),
        })
      );
    });
  });

  describe('repository validation', () => {
    test('returns 404 when user does not have access to the repository', async () => {
      setUserAuth();
      mockedGetGitHubInstallationIdForUser.mockResolvedValue('12345');
      mockedValidateGitHubRepoAccessForUser.mockResolvedValue(false);

      const response = await POST(
        makeRequest({
          ...validInput,
          githubRepo: 'nonexistent/repo',
        })
      );

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('Repository not found or not accessible');
      expect(body.details).toContainEqual(
        expect.objectContaining({
          path: 'githubRepo',
          message: expect.stringContaining('nonexistent/repo'),
        })
      );
    });

    test('returns 404 when organization does not have access to the repository', async () => {
      setUserAuth();
      const orgId = '123e4567-e89b-12d3-a456-426614174001';
      mockedEnsureOrganizationAccess.mockResolvedValue('member');
      mockedGetGitHubInstallationIdForOrganization.mockResolvedValue('67890');
      mockedValidateGitHubRepoAccessForOrganization.mockResolvedValue(false);

      const response = await POST(
        makeRequest({
          ...validInput,
          organizationId: orgId,
          githubRepo: 'nonexistent/repo',
        })
      );

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('Repository not found or not accessible');
    });

    test('returns 500 when repo validation fails with error', async () => {
      setUserAuth();
      mockedGetGitHubInstallationIdForUser.mockResolvedValue('12345');
      const { TRPCError } = await import('@trpc/server');
      mockedValidateGitHubRepoAccessForUser.mockRejectedValue(
        new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to validate repository access',
        })
      );

      const response = await POST(makeRequest(validInput));

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('Failed to validate repository access');
    });

    test('validates repo using user context when no organizationId', async () => {
      const user = setUserAuth();
      mockedGetGitHubInstallationIdForUser.mockResolvedValue('12345');
      mockedValidateGitHubRepoAccessForUser.mockResolvedValue(true);
      mockedCreateCloudAgentClient.mockReturnValue(
        createMockCloudAgentClient(
          jest.fn().mockResolvedValue({
            kiloSessionId: '123',
            cloudAgentSessionId: 'cloud-123',
          })
        )
      );

      await POST(makeRequest(validInput));

      expect(mockedValidateGitHubRepoAccessForUser).toHaveBeenCalledWith(user.id, 'owner/repo');
      expect(mockedValidateGitHubRepoAccessForOrganization).not.toHaveBeenCalled();
    });

    test('validates repo using organization context when organizationId provided', async () => {
      setUserAuth();
      const orgId = '123e4567-e89b-12d3-a456-426614174001';
      mockedEnsureOrganizationAccess.mockResolvedValue('member');
      mockedGetGitHubInstallationIdForOrganization.mockResolvedValue('67890');
      mockedValidateGitHubRepoAccessForOrganization.mockResolvedValue(true);
      mockedCreateCloudAgentClient.mockReturnValue(
        createMockCloudAgentClient(
          jest.fn().mockResolvedValue({
            kiloSessionId: '123',
            cloudAgentSessionId: 'cloud-123',
          })
        )
      );

      await POST(
        makeRequest({
          ...validInput,
          organizationId: orgId,
        })
      );

      expect(mockedValidateGitHubRepoAccessForOrganization).toHaveBeenCalledWith(
        orgId,
        'owner/repo'
      );
      expect(mockedValidateGitHubRepoAccessForUser).not.toHaveBeenCalled();
    });
  });

  describe('personal context (no organizationId)', () => {
    test('successfully prepares session with personal GitHub installation', async () => {
      const user = setUserAuth();
      const mockInstallationId = '12345';
      const mockResult = {
        kiloSessionId: '123e4567-e89b-12d3-a456-426614174000',
        cloudAgentSessionId: 'cloud-session-123',
      };

      mockedGetGitHubInstallationIdForUser.mockResolvedValue(mockInstallationId);
      mockedCreateCloudAgentClient.mockReturnValue(
        createMockCloudAgentClient(jest.fn().mockResolvedValue(mockResult))
      );

      const response = await POST(makeRequest(validInput));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({
        ...mockResult,
        ticket: 'test-ticket',
        expiresAt: 1234567890,
      });

      expect(mockedGetGitHubInstallationIdForUser).toHaveBeenCalledWith(user.id);
      expect(mockedGetGitHubInstallationIdForOrganization).not.toHaveBeenCalled();
    });

    test('works without GitHub installation (public repos)', async () => {
      setUserAuth();
      const mockResult = {
        kiloSessionId: '123e4567-e89b-12d3-a456-426614174000',
        cloudAgentSessionId: 'cloud-session-123',
      };

      mockedGetGitHubInstallationIdForUser.mockResolvedValue(undefined);
      mockedCreateCloudAgentClient.mockReturnValue(
        createMockCloudAgentClient(jest.fn().mockResolvedValue(mockResult))
      );

      const response = await POST(makeRequest(validInput));

      expect(response.status).toBe(200);
    });
  });

  describe('organization context', () => {
    test('successfully prepares session with organization GitHub installation', async () => {
      const user = setUserAuth();
      const orgId = '123e4567-e89b-12d3-a456-426614174001';
      const mockInstallationId = '67890';
      const mockResult = {
        kiloSessionId: '123e4567-e89b-12d3-a456-426614174000',
        cloudAgentSessionId: 'cloud-session-123',
      };

      mockedEnsureOrganizationAccess.mockResolvedValue('member');
      mockedGetGitHubInstallationIdForOrganization.mockResolvedValue(mockInstallationId);
      mockedCreateCloudAgentClient.mockReturnValue(
        createMockCloudAgentClient(jest.fn().mockResolvedValue(mockResult))
      );

      const response = await POST(
        makeRequest({
          ...validInput,
          organizationId: orgId,
        })
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({
        ...mockResult,
        ticket: 'test-ticket',
        expiresAt: 1234567890,
      });

      expect(mockedEnsureOrganizationAccess).toHaveBeenCalledWith({ user }, orgId);
      expect(mockedGetGitHubInstallationIdForOrganization).toHaveBeenCalledWith(orgId);
      expect(mockedGetGitHubInstallationIdForUser).not.toHaveBeenCalled();
    });

    test('returns 403 when user is not a member of the organization', async () => {
      setUserAuth();
      const orgId = '123e4567-e89b-12d3-a456-426614174001';

      const { TRPCError } = await import('@trpc/server');
      mockedEnsureOrganizationAccess.mockRejectedValue(
        new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'You do not have access to this organization',
        })
      );

      const response = await POST(
        makeRequest({
          ...validInput,
          organizationId: orgId,
        })
      );

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('You do not have access to this organization');
    });
  });

  describe('cloud-agent errors', () => {
    test('returns 402 for insufficient credits error', async () => {
      setUserAuth();
      mockedGetGitHubInstallationIdForUser.mockResolvedValue('12345');
      mockedCreateCloudAgentClient.mockReturnValue(
        createMockCloudAgentClient(
          jest.fn().mockRejectedValue(new Error('Insufficient credits: $1 minimum required'))
        )
      );

      const response = await POST(makeRequest(validInput));

      expect(response.status).toBe(402);
      const body = await response.json();
      expect(body.error).toContain('Insufficient credits');
    });

    test('returns 500 with generic message for other cloud-agent errors', async () => {
      setUserAuth();
      mockedGetGitHubInstallationIdForUser.mockResolvedValue('12345');
      mockedCreateCloudAgentClient.mockReturnValue(
        createMockCloudAgentClient(
          jest.fn().mockRejectedValue(new Error('Internal cloud-agent error'))
        )
      );

      const response = await POST(makeRequest(validInput));

      expect(response.status).toBe(500);
      const body = await response.json();
      // Generic message to avoid leaking implementation details
      expect(body.error).toBe('Failed to prepare session');
    });

    test('returns 500 with generic message for network errors like "fetch failed"', async () => {
      setUserAuth();
      mockedGetGitHubInstallationIdForUser.mockResolvedValue('12345');
      mockedCreateCloudAgentClient.mockReturnValue(
        createMockCloudAgentClient(jest.fn().mockRejectedValue(new Error('fetch failed')))
      );

      const response = await POST(makeRequest(validInput));

      expect(response.status).toBe(500);
      const body = await response.json();
      // Should NOT leak "fetch failed" which exposes the proxy implementation
      expect(body.error).toBe('Failed to prepare session');
    });
  });

  describe('optional fields', () => {
    test('passes through envVars, setupCommands, mcpServers, and autoCommit', async () => {
      setUserAuth();
      const mockPrepareSession = jest.fn().mockResolvedValue({
        kiloSessionId: '123e4567-e89b-12d3-a456-426614174000',
        cloudAgentSessionId: 'cloud-session-123',
      });

      mockedGetGitHubInstallationIdForUser.mockResolvedValue('12345');
      mockedCreateCloudAgentClient.mockReturnValue(createMockCloudAgentClient(mockPrepareSession));

      const inputWithOptionals = {
        ...validInput,
        envVars: { MY_VAR: 'my-value' },
        setupCommands: ['npm install'],
        mcpServers: {
          myServer: {
            command: 'node',
            args: ['server.js'],
          },
        },
        autoCommit: true,
      };

      mockedMergeProfileConfiguration.mockResolvedValueOnce({
        envVars: inputWithOptionals.envVars,
        setupCommands: inputWithOptionals.setupCommands,
        encryptedSecrets: undefined,
      });

      await POST(makeRequest(inputWithOptionals));

      expect(mockPrepareSession).toHaveBeenCalledWith(
        expect.objectContaining({
          envVars: { MY_VAR: 'my-value' },
          setupCommands: ['npm install'],
          mcpServers: {
            myServer: {
              command: 'node',
              args: ['server.js'],
            },
          },
          autoCommit: true,
        })
      );
    });
  });

  describe('profileName integration', () => {
    test('merges profile configuration before calling cloud-agent', async () => {
      const user = setUserAuth();
      mockedGetGitHubInstallationIdForUser.mockResolvedValue('12345');
      const mockPrepareSession = jest.fn().mockResolvedValue({
        kiloSessionId: '123e4567-e89b-12d3-a456-426614174000',
        cloudAgentSessionId: 'cloud-session-123',
      });
      mockedCreateCloudAgentClient.mockReturnValue(createMockCloudAgentClient(mockPrepareSession));

      const mergedConfig: MergeProfileConfigurationResult = {
        envVars: { FROM_PROFILE: 'value' },
        setupCommands: ['pnpm install'],
        encryptedSecrets: undefined,
      };
      mockedMergeProfileConfiguration.mockResolvedValueOnce(mergedConfig);

      await POST(
        makeRequest({
          ...validInput,
          profileName: 'My Default',
          envVars: { INLINE: 'value' },
          setupCommands: ['echo inline'],
        })
      );

      expect(mockedMergeProfileConfiguration).toHaveBeenCalledWith({
        profileName: 'My Default',
        owner: { type: 'user', id: user.id },
        envVars: { INLINE: 'value' },
        setupCommands: ['echo inline'],
      });

      expect(mockPrepareSession).toHaveBeenCalledWith(
        expect.objectContaining({
          envVars: mergedConfig.envVars,
          setupCommands: mergedConfig.setupCommands,
        })
      );
    });

    test('returns 404 when the profile cannot be found', async () => {
      setUserAuth();
      mockedMergeProfileConfiguration.mockRejectedValueOnce(new ProfileNotFoundError('Missing'));

      const response = await POST(
        makeRequest({
          ...validInput,
          profileName: 'Missing',
        })
      );

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('Profile not found');
      expect(body.details).toContainEqual(
        expect.objectContaining({
          path: 'profileName',
        })
      );
    });

    test('passes encryptedSecrets from profile to cloud-agent worker', async () => {
      setUserAuth();
      mockedGetGitHubInstallationIdForUser.mockResolvedValue('12345');
      const mockPrepareSession = jest.fn().mockResolvedValue({
        kiloSessionId: '123e4567-e89b-12d3-a456-426614174000',
        cloudAgentSessionId: 'cloud-session-123',
      });
      mockedCreateCloudAgentClient.mockReturnValue(createMockCloudAgentClient(mockPrepareSession));

      const encryptedEnvelope = {
        encryptedData: 'base64-encrypted-data',
        encryptedDEK: 'base64-encrypted-dek',
        algorithm: 'rsa-aes-256-gcm' as const,
        version: 1 as const,
      };

      const mergedConfig: MergeProfileConfigurationResult = {
        envVars: { PUBLIC_VAR: 'value' },
        setupCommands: ['npm install'],
        encryptedSecrets: { SECRET_KEY: encryptedEnvelope },
      };
      mockedMergeProfileConfiguration.mockResolvedValueOnce(mergedConfig);

      await POST(
        makeRequest({
          ...validInput,
          profileName: 'production',
        })
      );

      expect(mockPrepareSession).toHaveBeenCalledWith(
        expect.objectContaining({
          envVars: { PUBLIC_VAR: 'value' },
          encryptedSecrets: { SECRET_KEY: encryptedEnvelope },
          setupCommands: ['npm install'],
        })
      );
    });
  });
});
