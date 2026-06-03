import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

// Mock Cloudflare sandbox to prevent module resolution errors
vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: vi.fn(),
}));

const { buildContextMock, getOrCreateSessionMock, recordCloudAgentSessionFailureMock } = vi.hoisted(
  () => ({
    buildContextMock: vi.fn(),
    getOrCreateSessionMock: vi.fn(),
    recordCloudAgentSessionFailureMock: vi.fn(),
  })
);

const { getSandboxIdForSessionMock, metadataMock } = vi.hoisted(() => ({
  getSandboxIdForSessionMock: vi.fn(),
  metadataMock: vi.fn(),
}));

const { preflightExistingPromptModelMock, preflightPreparedInitialPromptModelMock } = vi.hoisted(
  () => ({
    preflightExistingPromptModelMock: vi.fn(),
    preflightPreparedInitialPromptModelMock: vi.fn(),
  })
);

vi.mock('./session/model-preflight.js', () => ({
  preflightExistingPromptModel: preflightExistingPromptModelMock,
  preflightPreparedInitialPromptModel: preflightPreparedInitialPromptModelMock,
}));

vi.mock('./telemetry/session-reports.js', () => ({
  createCloudAgentSessionReport: vi.fn().mockResolvedValue(undefined),
  recordCloudAgentSandboxIdentity: vi.fn().mockResolvedValue(undefined),
  recordCloudAgentSessionFailure: async (params: {
    cloudAgentSessionId: string;
    failure: unknown;
  }) =>
    recordCloudAgentSessionFailureMock({
      ...params,
      occurredAt: new Date().toISOString(),
    }),
}));

vi.mock('./session-service.js', () => ({
  generateSessionId: vi.fn(() => 'agent_12345678-1234-1234-1234-123456789abc'),
  fetchSessionMetadata: vi.fn(),
  InvalidSessionMetadataError: class InvalidSessionMetadataError extends Error {
    constructor(
      public readonly userId: string,
      public readonly sessionId: string,
      public readonly details?: string
    ) {
      super(`Invalid session metadata for session ${sessionId}`);
      this.name = 'InvalidSessionMetadataError';
    }
  },
  SessionService: class SessionService {
    constructor() {
      this.buildContext = buildContextMock;
      this.getOrCreateSession = getOrCreateSessionMock;
      this.getSandboxIdForSession = getSandboxIdForSessionMock;
    }
    buildContext!: typeof buildContextMock;
    getOrCreateSession!: typeof getOrCreateSessionMock;
    getSandboxIdForSession!: typeof getSandboxIdForSessionMock;
    get metadata() {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return metadataMock();
    }
  },
}));

import { getSandbox } from '@cloudflare/sandbox';
import { generateSessionId, fetchSessionMetadata } from './session-service.js';
import { sessionIdSchema, envVarsSchema } from './types.js';
import { appRouter } from './router.js';
import type { Env, TRPCContext, SessionId } from './types.js';
import type { CloudAgentSessionState } from './persistence/types.js';
import { parseSessionMetadata } from './persistence/session-metadata.js';

type MockSessionStub = {
  deleteSession?: ReturnType<typeof vi.fn>;
  markAsInterrupted?: ReturnType<typeof vi.fn>;
  interruptExecution?: ReturnType<typeof vi.fn>;
  getCurrentRuntimeExecution?: ReturnType<typeof vi.fn>;
  getCurrentMessageWork?: ReturnType<typeof vi.fn>;
  getMetadata?: ReturnType<typeof vi.fn>;
  getActiveExecutionId?: ReturnType<typeof vi.fn>;
  getExecution?: ReturnType<typeof vi.fn>;
  getLatestAssistantMessage?: ReturnType<typeof vi.fn>;
  getMessageResult?: ReturnType<typeof vi.fn>;
  createTerminal?: ReturnType<typeof vi.fn>;
  resizeTerminal?: ReturnType<typeof vi.fn>;
  closeTerminal?: ReturnType<typeof vi.fn>;
};

type MockCAS = {
  idFromName: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn<() => MockSessionStub>>;
};

function legacySessionMetadata(input: Record<string, unknown>): CloudAgentSessionState {
  return parseSessionMetadata(input);
}

// Note: Balance validation is now handled in the worker entry point (index.ts)
// via pre-flight validation before the tRPC handler is called.
// This returns proper HTTP status codes (401, 402) instead of SSE error events.
// See cloud-agent/src/balance-validation.ts for the implementation.
// Tests for balance validation are in cloud-agent/src/balance-validation.test.ts

describe('router sessionId validation', () => {
  it('should reject invalid session ID formats', () => {
    const invalidIds = [
      // Path traversal and command injection
      'agent_../../etc/passwd',
      'agent_abc123; rm -rf /',
      '../agent_12345678-1234-1234-1234-123456789abc',
      // Missing or wrong prefix
      'session_12345678-1234-1234-1234-123456789abc',
      '12345678-1234-1234-1234-123456789abc',
      // Incomplete formats
      'agent_',
      'agent_incomplete',
      '',
      // Special characters
      'agent_test%00null',
      'agent_<script>alert(1)</script>',
      // Non-hex characters in UUID
      'agent_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      'agent_ZZZZZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZZZZZZZZZ',
      // Wrong UUID length/format
      'agent_12345678-1234-1234-1234-123456789ab',
      'agent_123456781234123412341234567890abc',
      // Whitespace/extra characters
      'agent_12345678-1234-1234-1234-123456789abc ',
      ' agent_12345678-1234-1234-1234-123456789abc',
    ];

    for (const invalidId of invalidIds) {
      const result = sessionIdSchema.safeParse(invalidId);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe('Invalid session ID format');
      }
    }
  });

  it('should accept valid session ID formats', () => {
    const validIds = [
      'agent_12345678-1234-1234-1234-123456789abc',
      'agent_00000000-0000-0000-0000-000000000000',
      'agent_ffffffff-ffff-ffff-ffff-ffffffffffff',
      'agent_ABCDEF01-2345-6789-ABCD-EF0123456789', // Case-insensitive
      'agent_Abcd1234-5678-90AB-cdef-0123456789aB', // Mixed case
    ];

    for (const validId of validIds) {
      const result = sessionIdSchema.safeParse(validId);
      expect(result.success).toBe(true);
    }
  });

  it('should accept session IDs generated by generateSessionId()', () => {
    const generatedId = generateSessionId();
    const result = sessionIdSchema.safeParse(generatedId);
    expect(result.success).toBe(true);
  });

  describe('envVars validation', () => {
    it('should reject HOME variable', () => {
      const result = envVarsSchema.safeParse({ HOME: '/custom/home' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain('reserved environment variables');
        expect(result.error.issues[0]?.message).toContain('HOME');
      }
    });

    it('should reject SESSION_ID variable', () => {
      const result = envVarsSchema.safeParse({ SESSION_ID: 'custom-id' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain('reserved environment variables');
        expect(result.error.issues[0]?.message).toContain('SESSION_ID');
      }
    });

    it('should reject SESSION_HOME variable', () => {
      const result = envVarsSchema.safeParse({ SESSION_HOME: '/custom/session' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain('reserved environment variables');
        expect(result.error.issues[0]?.message).toContain('SESSION_HOME');
      }
    });

    it('should reject multiple reserved variables', () => {
      const result = envVarsSchema.safeParse({
        HOME: '/custom/home',
        SESSION_ID: 'custom-id',
        API_KEY: 'valid-key',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain('reserved environment variables');
      }
    });

    it('should allow non-reserved variables', () => {
      const result = envVarsSchema.safeParse({
        API_KEY: 'my-api-key',
        DATABASE_URL: 'postgresql://localhost:5432/mydb',
        NODE_ENV: 'production',
        CUSTOM_VAR: 'custom-value',
      });
      expect(result.success).toBe(true);
    });

    it('should reject undefined (schema requires actual object)', () => {
      // The envVarsSchema itself requires an object when used
      // Optionality is handled at the parent schema level
      const result = envVarsSchema.safeParse(undefined);
      expect(result.success).toBe(false);
    });

    it('should allow empty env vars object', () => {
      const result = envVarsSchema.safeParse({});
      expect(result.success).toBe(true);
    });
  });

  describe('sandboxId generation with hash format', () => {
    describe('format validation', () => {
      it('should generate sandboxId with org prefix for organization accounts', async () => {
        const { generateSandboxId } = await import('./sandbox-id.js');
        const sandboxId = await generateSandboxId(undefined, 'org-123', 'user-456', 's');
        expect(sandboxId).toMatch(/^org-[0-9a-f]{48}$/);
        expect(sandboxId.length).toBe(52);
      });

      it('should generate sandboxId with bot prefix when botId is provided', async () => {
        const { generateSandboxId } = await import('./sandbox-id.js');
        const sandboxId = await generateSandboxId(
          undefined,
          'org-123',
          'user-456',
          's',
          'reviewer'
        );
        expect(sandboxId).toMatch(/^bot-[0-9a-f]{48}$/);
        expect(sandboxId.length).toBe(52);
      });
    });

    describe('personal accounts', () => {
      it('should generate sandboxId with usr prefix for personal accounts', async () => {
        const { generateSandboxId } = await import('./sandbox-id.js');
        const sandboxId = await generateSandboxId(undefined, undefined, 'abc-123', 's');
        expect(sandboxId).toMatch(/^usr-[0-9a-f]{48}$/);
        expect(sandboxId.length).toBe(52);
      });

      it('should generate sandboxId with ubt prefix for personal bot accounts', async () => {
        const { generateSandboxId } = await import('./sandbox-id.js');
        const sandboxId = await generateSandboxId(undefined, undefined, 'abc-123', 's', 'reviewer');
        expect(sandboxId).toMatch(/^ubt-[0-9a-f]{48}$/);
        expect(sandboxId.length).toBe(52);
      });
    });

    describe('collision prevention', () => {
      it('should prevent collision between org and personal accounts', async () => {
        const { generateSandboxId } = await import('./sandbox-id.js');
        const userId = 'same-user-id';

        const orgSandboxId = await generateSandboxId(undefined, 'org-123', userId, 's');
        const personalSandboxId = await generateSandboxId(undefined, undefined, userId, 's');

        expect(orgSandboxId).not.toBe(personalSandboxId);
        expect(orgSandboxId).toMatch(/^org-[0-9a-f]{48}$/);
        expect(personalSandboxId).toMatch(/^usr-[0-9a-f]{48}$/);
      });

      describe('deleteSession procedure', () => {
        let mockContext: TRPCContext;
        let mockSandbox: ReturnType<typeof getSandbox>;
        let caller: ReturnType<typeof appRouter.createCaller>;
        let cloudAgentSession: MockCAS;

        beforeEach(() => {
          vi.clearAllMocks();
          buildContextMock.mockImplementation(
            ({
              sandboxId,
              orgId,
              userId,
              sessionId,
            }: {
              sandboxId: string;
              orgId: string | undefined;
              userId: string;
              sessionId: string;
            }) => ({
              sandboxId,
              orgId,
              userId,
              sessionId,
              sessionHome: `/home/${sessionId}`,
              workspacePath: `/workspace/${sessionId}`,
              branchName: `session/${sessionId}`,
            })
          );
          const mockSession = { token: 'session' };
          getOrCreateSessionMock.mockResolvedValue(mockSession);

          // Mock context
          mockContext = {
            userId: 'test-user-123',
            authToken: 'test-token',
            botId: undefined,
            request: {} as Request,
            env: {
              Sandbox: {} as TRPCContext['env']['Sandbox'],
              SandboxSmall: {} as TRPCContext['env']['SandboxSmall'],
              SandboxDIND: {} as TRPCContext['env']['SandboxDIND'],
              CLOUD_AGENT_SESSION: {
                idFromName: vi.fn((id: string) => ({ id })),
                get: vi.fn(() => ({
                  deleteSession: vi.fn().mockResolvedValue(undefined),
                  markAsInterrupted: vi.fn().mockResolvedValue(undefined),
                  getCurrentRuntimeExecution: vi.fn().mockResolvedValue(null),
                })),
              } as unknown as TRPCContext['env']['CLOUD_AGENT_SESSION'],
              USER_KILO_FACADE: {} as TRPCContext['env']['USER_KILO_FACADE'],
              SESSION_INGEST: {
                fetch: vi.fn(),
              } as unknown as TRPCContext['env']['SESSION_INGEST'],
              R2_BUCKET: {} as TRPCContext['env']['R2_BUCKET'],
              CLOUD_AGENT_REPORT_QUEUE: {} as TRPCContext['env']['CLOUD_AGENT_REPORT_QUEUE'],
              GIT_TOKEN_SERVICE: {} as Env['GIT_TOKEN_SERVICE'],
              NEXTAUTH_SECRET: 'test-secret',
              INTERNAL_API_SECRET_PROD: {
                get: vi.fn().mockResolvedValue('test-secret'),
              } as unknown as TRPCContext['env']['INTERNAL_API_SECRET_PROD'],
              HYPERDRIVE: {
                connectionString: 'postgresql://test',
              } as TRPCContext['env']['HYPERDRIVE'],
              NOTIFICATIONS: {} as TRPCContext['env']['NOTIFICATIONS'],
            },
          };
          cloudAgentSession = mockContext.env.CLOUD_AGENT_SESSION as unknown as MockCAS;

          // Mock sandbox with deleteSession method
          mockSandbox = {
            deleteSession: vi.fn().mockResolvedValue(undefined),
          } as unknown as ReturnType<typeof getSandbox>;

          vi.mocked(getSandbox).mockReturnValue(mockSandbox);

          // Create caller with mocked context
          caller = appRouter.createCaller(mockContext);
        });

        describe('successful deletion', () => {
          it('should successfully delete existing session', async () => {
            const sessionId: SessionId = 'agent_12345678-1234-1234-1234-123456789abc';
            const metadata = legacySessionMetadata({
              version: 123456789,
              sessionId,
              orgId: 'org-123',
              userId: 'test-user-123',
              timestamp: 123456789,
            });

            vi.mocked(fetchSessionMetadata).mockResolvedValue(metadata);
            const deleteSessionMock = vi.fn().mockResolvedValue(undefined);
            vi.mocked(cloudAgentSession.get).mockReturnValue({
              deleteSession: deleteSessionMock,
              markAsInterrupted: vi.fn().mockResolvedValue(undefined),
            });

            const result = await caller.deleteSession({ sessionId });

            expect(result).toEqual({ success: true });
            expect(fetchSessionMetadata).toHaveBeenCalledWith(
              mockContext.env,
              'test-user-123',
              sessionId
            );
            expect(getSandbox).not.toHaveBeenCalled();
            // eslint-disable-next-line @typescript-eslint/unbound-method
            const sandboxDelete = vi.mocked(mockSandbox.deleteSession);
            expect(sandboxDelete).not.toHaveBeenCalled();
            expect(cloudAgentSession.idFromName).toHaveBeenCalledWith(
              `${metadata.identity.userId}:${sessionId}`
            );
            expect(deleteSessionMock).toHaveBeenCalledWith();
          });

          it('trusted cleanup deletes Durable Object state', async () => {
            const sessionId: SessionId = 'agent_12121212-3434-5656-7878-909090909090';
            const metadata = legacySessionMetadata({
              version: 123456789,
              sessionId,
              orgId: 'org-123',
              userId: 'test-user-123',
              timestamp: 123456789,
            });
            vi.mocked(fetchSessionMetadata).mockResolvedValue(metadata);
            const deleteSessionMock = vi.fn().mockResolvedValue(undefined);
            vi.mocked(cloudAgentSession.get).mockReturnValue({
              deleteSession: deleteSessionMock,
              markAsInterrupted: vi.fn().mockResolvedValue(undefined),
            });
            const headers = new Headers({ 'x-internal-api-key': 'test-internal-api-secret' });
            const cleanupContext = {
              ...mockContext,
              request: new Request('https://cloud-agent-next.test/trpc', { headers }),
              env: { ...mockContext.env, INTERNAL_API_SECRET: 'test-internal-api-secret' },
            } as TRPCContext;

            const result = await appRouter
              .createCaller(cleanupContext)
              .cleanupSession({ sessionId });

            expect(result).toEqual({ success: true });
            expect(deleteSessionMock).toHaveBeenCalledWith();
          });

          it('should successfully delete session for personal account', async () => {
            const sessionId: SessionId = 'agent_abcdef01-2345-6789-abcd-ef0123456789';
            const metadata = legacySessionMetadata({
              version: 123456789,
              sessionId,
              orgId: undefined, // Personal account
              userId: 'test-user-123',
              timestamp: 123456789,
            });

            vi.mocked(fetchSessionMetadata).mockResolvedValue(metadata);

            const result = await caller.deleteSession({ sessionId });

            expect(result).toEqual({ success: true });
            expect(getSandbox).not.toHaveBeenCalled();
          });

          it('should successfully delete session with botId', async () => {
            const sessionId: SessionId = 'agent_11111111-2222-3333-4444-555555555555';
            const metadata = legacySessionMetadata({
              version: 123456789,
              sessionId,
              orgId: 'org-123',
              userId: 'test-user-123',
              timestamp: 123456789,
              botId: 'reviewer',
            });

            vi.mocked(fetchSessionMetadata).mockResolvedValue(metadata);

            const result = await caller.deleteSession({ sessionId });

            expect(result).toEqual({ success: true });
            expect(getSandbox).not.toHaveBeenCalled();
          });

          it('should route per-session sandbox ID to SandboxSmall namespace', async () => {
            const sessionId: SessionId = 'agent_22222222-3333-4444-5555-666666666666';
            const perSessionSandboxId = 'ses-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6';
            const metadata = legacySessionMetadata({
              version: 123456789,
              sessionId,
              orgId: 'org-123',
              userId: 'test-user-123',
              timestamp: 123456789,
              sandboxId: perSessionSandboxId,
            });

            vi.mocked(fetchSessionMetadata).mockResolvedValue(metadata);

            const result = await caller.deleteSession({ sessionId });

            expect(result).toEqual({ success: true });
            expect(getSandbox).not.toHaveBeenCalled();
          });
        });

        describe('idempotency', () => {
          it('treats deletion without runtime metadata as idempotent', async () => {
            const sessionId: SessionId = 'agent_00000000-0000-0000-0000-000000000000';
            vi.mocked(fetchSessionMetadata).mockResolvedValue(null);

            const result = await caller.deleteSession({ sessionId });

            expect(result).toEqual({
              success: true,
              message: 'Session not found or already deleted',
            });
            expect(getSandbox).not.toHaveBeenCalled();
            expect(cloudAgentSession.get).not.toHaveBeenCalled();
          });
        });

        describe('provider deletion ownership', () => {
          it('does not perform provider deletion outside the Durable Object', async () => {
            const sessionId: SessionId = 'agent_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
            const metadata = legacySessionMetadata({
              version: 123456789,
              sessionId,
              orgId: 'org-123',
              userId: 'test-user-123',
              timestamp: 123456789,
            });

            vi.mocked(fetchSessionMetadata).mockResolvedValue(metadata);
            mockSandbox.deleteSession = vi.fn().mockRejectedValue(new Error('must not be called'));
            const deleteSessionMock = vi.mocked(cloudAgentSession.get).mockReturnValue({
              deleteSession: vi.fn().mockResolvedValue(undefined),
              markAsInterrupted: vi.fn().mockResolvedValue(undefined),
            });

            const result = await caller.deleteSession({ sessionId });

            expect(result).toEqual({ success: true });
            // eslint-disable-next-line @typescript-eslint/unbound-method
            const sandboxDelete = vi.mocked(mockSandbox.deleteSession);
            expect(sandboxDelete).not.toHaveBeenCalled();
            expect(getSandbox).not.toHaveBeenCalled();
            expect(deleteSessionMock().deleteSession).toHaveBeenCalled();
          });
        });

        describe('DO cleanup failure handling', () => {
          it('should fail when DO cleanup fails', async () => {
            const sessionId: SessionId = 'agent_ffffffff-ffff-ffff-ffff-ffffffffffff';
            const metadata = legacySessionMetadata({
              version: 123456789,
              sessionId,
              orgId: 'org-123',
              userId: 'test-user-123',
              timestamp: 123456789,
            });

            vi.mocked(fetchSessionMetadata).mockResolvedValue(metadata);
            const deleteSessionMock = vi.mocked(cloudAgentSession.get).mockReturnValue({
              deleteSession: vi.fn().mockRejectedValue(new Error('connection lost')),
              markAsInterrupted: vi.fn().mockResolvedValue(undefined),
            });

            await expect(caller.deleteSession({ sessionId })).rejects.toThrow(TRPCError);
            await expect(caller.deleteSession({ sessionId })).rejects.toThrow(
              'Failed to clean up session metadata'
            );
            expect(deleteSessionMock().deleteSession).toHaveBeenCalled();
          });

          it('should succeed when DO cleanup succeeds', async () => {
            const sessionId: SessionId = 'agent_11111111-1111-1111-1111-111111111111';
            const metadata = legacySessionMetadata({
              version: 123456789,
              sessionId,
              orgId: 'org-123',
              userId: 'test-user-123',
              timestamp: 123456789,
            });

            vi.mocked(fetchSessionMetadata).mockResolvedValue(metadata);
            const deleteSessionMock = vi.mocked(cloudAgentSession.get).mockReturnValue({
              deleteSession: vi.fn().mockResolvedValue(undefined),
              markAsInterrupted: vi.fn().mockResolvedValue(undefined),
            });

            const result = await caller.deleteSession({ sessionId });

            // Should still succeed overall - partial cleanup is acceptable
            expect(result).toEqual({ success: true });
            expect(deleteSessionMock().deleteSession).toHaveBeenCalled();
          });

          it('should succeed when DO cleanup succeeds (no partial R2 path)', async () => {
            const sessionId: SessionId = 'agent_22222222-2222-2222-2222-222222222222';
            const metadata = legacySessionMetadata({
              version: 123456789,
              sessionId,
              orgId: 'org-123',
              userId: 'test-user-123',
              timestamp: 123456789,
            });

            vi.mocked(fetchSessionMetadata).mockResolvedValue(metadata);
            const deleteSessionMock = vi.mocked(cloudAgentSession.get).mockReturnValue({
              deleteSession: vi.fn().mockResolvedValue(undefined),
              markAsInterrupted: vi.fn().mockResolvedValue(undefined),
            });

            const result = await caller.deleteSession({ sessionId });

            // Should still succeed overall - partial cleanup is acceptable
            expect(result).toEqual({ success: true });
            expect(deleteSessionMock().deleteSession).toHaveBeenCalled();
          });
        });

        describe('authorization', () => {
          it('should require authentication', async () => {
            const unauthenticatedContext: TRPCContext = {
              userId: undefined,
              authToken: undefined,
              botId: undefined,
              env: mockContext.env,
            } as unknown as TRPCContext;

            const unauthenticatedCaller = appRouter.createCaller(unauthenticatedContext);

            await expect(
              unauthenticatedCaller.deleteSession({ sessionId: 'agent_test' })
            ).rejects.toThrow('Authentication required');
          });

          it('does not delete runtime state for a guessed session belonging to another user', async () => {
            const sessionId: SessionId = 'agent_99999999-8888-7777-6666-555555555555';
            vi.mocked(fetchSessionMetadata).mockResolvedValue(null);

            const result = await caller.deleteSession({ sessionId });

            expect(result).toEqual({
              success: true,
              message: 'Session not found or already deleted',
            });
            expect(getSandbox).not.toHaveBeenCalled();
          });
        });

        describe('error handling', () => {
          it('should handle metadata fetch errors', async () => {
            const sessionId: SessionId = 'agent_deadbeef-dead-beef-dead-beefdeadbeef';

            vi.mocked(fetchSessionMetadata).mockRejectedValue(new Error('Metadata fetch failed'));

            await expect(caller.deleteSession({ sessionId })).rejects.toThrow(TRPCError);
            await expect(caller.deleteSession({ sessionId })).rejects.toThrow(
              'Failed to delete session'
            );
          });

          it('should wrap non-TRPCError errors', async () => {
            const sessionId: SessionId = 'agent_cafebabe-cafe-babe-cafe-babecafebabe';

            vi.mocked(fetchSessionMetadata).mockRejectedValue(new Error('Generic error'));

            await expect(caller.deleteSession({ sessionId })).rejects.toThrow(TRPCError);

            try {
              await caller.deleteSession({ sessionId });
            } catch (error) {
              expect(error).toBeInstanceOf(TRPCError);
              expect((error as TRPCError).code).toBe('INTERNAL_SERVER_ERROR');
            }
          });

          it('should preserve TRPCError instances', async () => {
            const sessionId: SessionId = 'agent_facefeed-face-feed-face-feedfacefeed';
            const originalError = new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'Session metadata is invalid',
            });

            vi.mocked(fetchSessionMetadata).mockRejectedValue(originalError);

            await expect(caller.deleteSession({ sessionId })).rejects.toThrow(originalError);
          });
        });
      });

      it('should prevent collision between user and bot sessions', async () => {
        const { generateSandboxId } = await import('./sandbox-id.js');
        const orgId = 'org-123';
        const userId = 'user-456';
        const botId = 'reviewer';

        const userSandboxId = await generateSandboxId(undefined, orgId, userId, 's');
        const botSandboxId = await generateSandboxId(undefined, orgId, userId, 's', botId);

        expect(userSandboxId).not.toBe(botSandboxId);
        expect(userSandboxId).toMatch(/^org-[0-9a-f]{48}$/);
        expect(botSandboxId).toMatch(/^bot-[0-9a-f]{48}$/);
      });
    });

    describe('interruptSession procedure', () => {
      let mockContext: TRPCContext;
      let caller: ReturnType<typeof appRouter.createCaller>;
      let cloudAgentSession: MockCAS;
      let mockSessionStub: MockSessionStub;

      beforeEach(() => {
        vi.clearAllMocks();
        mockSessionStub = {
          deleteSession: vi.fn().mockResolvedValue(undefined),
          markAsInterrupted: vi.fn().mockResolvedValue(undefined),
          interruptExecution: vi.fn().mockResolvedValue({
            success: true,
            executionId: 'exc_interrupt_runtime',
          }),
          getCurrentRuntimeExecution: vi.fn().mockResolvedValue(null),
          getMetadata: vi.fn().mockResolvedValue(null),
        };

        mockContext = {
          userId: 'test-user-123',
          authToken: 'test-token',
          botId: undefined,
          request: {} as Request,
          env: {
            Sandbox: {} as TRPCContext['env']['Sandbox'],
            SandboxSmall: {} as TRPCContext['env']['SandboxSmall'],
            SandboxDIND: {} as TRPCContext['env']['SandboxDIND'],
            CLOUD_AGENT_SESSION: {
              idFromName: vi.fn((id: string) => ({ id })),
              get: vi.fn(() => mockSessionStub),
            } as unknown as TRPCContext['env']['CLOUD_AGENT_SESSION'],
            USER_KILO_FACADE: {} as TRPCContext['env']['USER_KILO_FACADE'],
            SESSION_INGEST: {
              fetch: vi.fn(),
            } as unknown as TRPCContext['env']['SESSION_INGEST'],
            GIT_TOKEN_SERVICE: {} as Env['GIT_TOKEN_SERVICE'],
            R2_BUCKET: {} as TRPCContext['env']['R2_BUCKET'],
            CLOUD_AGENT_REPORT_QUEUE: {} as TRPCContext['env']['CLOUD_AGENT_REPORT_QUEUE'],
            NEXTAUTH_SECRET: 'test-secret',
            INTERNAL_API_SECRET_PROD: {
              get: vi.fn().mockResolvedValue('test-secret'),
            } as unknown as TRPCContext['env']['INTERNAL_API_SECRET_PROD'],
            HYPERDRIVE: {
              connectionString: 'postgresql://test',
            } as unknown as TRPCContext['env']['HYPERDRIVE'],
            NOTIFICATIONS: {} as TRPCContext['env']['NOTIFICATIONS'],
          },
        };
        cloudAgentSession = mockContext.env.CLOUD_AGENT_SESSION as unknown as MockCAS;

        caller = appRouter.createCaller(mockContext);
      });

      it('routes accepted interruption to the Durable Object without provider stopping', async () => {
        const sessionId: SessionId = 'agent_87654321-1234-1234-1234-123456789abc';
        const metadata = legacySessionMetadata({
          version: 123456789,
          sessionId,
          orgId: 'org-123',
          userId: 'test-user-123',
          timestamp: 123456789,
        });
        vi.mocked(fetchSessionMetadata).mockResolvedValue(metadata);

        const result = await caller.interruptSession({ sessionId });

        expect(result).toEqual({
          success: true,
          message: 'Session interruption accepted',
          processesFound: false,
        });
        expect(mockSessionStub.interruptExecution).toHaveBeenCalled();
        expect(getSandbox).not.toHaveBeenCalled();
      });

      it('short-circuits queued-only interrupts before creating a sandbox session', async () => {
        const sessionId: SessionId = 'agent_12345678-1234-1234-1234-123456789abc';
        const metadata = legacySessionMetadata({
          version: 123456789,
          sessionId,
          orgId: 'org-123',
          userId: 'test-user-123',
          timestamp: 123456789,
        });

        vi.mocked(fetchSessionMetadata).mockResolvedValue(metadata);
        mockSessionStub.interruptExecution = vi.fn().mockResolvedValue({
          success: true,
          executionId: undefined,
        });

        const result = await caller.interruptSession({ sessionId });

        expect(result).toEqual({
          success: true,
          message: 'Session interruption accepted',
          processesFound: false,
        });

        expect(mockSessionStub.markAsInterrupted).toHaveBeenCalled();
        expect(mockSessionStub.interruptExecution).toHaveBeenCalled();
        expect(getOrCreateSessionMock).not.toHaveBeenCalled();
        expect(getSandbox).not.toHaveBeenCalled();
        expect(cloudAgentSession.idFromName).toHaveBeenCalledWith(`test-user-123:${sessionId}`);
      });
    });

    describe('getSession procedure', () => {
      let mockContext: TRPCContext;
      let caller: ReturnType<typeof appRouter.createCaller>;
      let cloudAgentSession: MockCAS;
      let mockGetMetadata: ReturnType<typeof vi.fn>;
      let mockGetCurrentRuntimeExecution: ReturnType<typeof vi.fn>;
      let mockGetCurrentMessageWork: ReturnType<typeof vi.fn>;

      beforeEach(() => {
        vi.clearAllMocks();

        mockGetMetadata = vi.fn();
        mockGetCurrentRuntimeExecution = vi.fn().mockResolvedValue(null);
        mockGetCurrentMessageWork = vi.fn().mockResolvedValue(null);

        // Mock context
        mockContext = {
          userId: 'test-user-123',
          authToken: 'test-token',
          botId: undefined,
          request: {} as Request,
          env: {
            Sandbox: {} as TRPCContext['env']['Sandbox'],
            SandboxSmall: {} as TRPCContext['env']['SandboxSmall'],
            SandboxDIND: {} as TRPCContext['env']['SandboxDIND'],
            CLOUD_AGENT_SESSION: {
              idFromName: vi.fn((id: string) => ({ id })),
              get: vi.fn(() => ({
                getMetadata: mockGetMetadata,
                getCurrentRuntimeExecution: mockGetCurrentRuntimeExecution,
                getCurrentMessageWork: mockGetCurrentMessageWork,
              })),
            } as unknown as TRPCContext['env']['CLOUD_AGENT_SESSION'],
            USER_KILO_FACADE: {} as TRPCContext['env']['USER_KILO_FACADE'],
            SESSION_INGEST: {
              fetch: vi.fn(),
            } as unknown as TRPCContext['env']['SESSION_INGEST'],
            R2_BUCKET: {} as TRPCContext['env']['R2_BUCKET'],
            CLOUD_AGENT_REPORT_QUEUE: {} as TRPCContext['env']['CLOUD_AGENT_REPORT_QUEUE'],
            GIT_TOKEN_SERVICE: {} as Env['GIT_TOKEN_SERVICE'],
            NEXTAUTH_SECRET: 'test-secret',
            INTERNAL_API_SECRET_PROD: {
              get: vi.fn().mockResolvedValue('test-secret'),
            } as unknown as TRPCContext['env']['INTERNAL_API_SECRET_PROD'],
            HYPERDRIVE: {
              connectionString: 'postgresql://test',
            } as unknown as TRPCContext['env']['HYPERDRIVE'],
            NOTIFICATIONS: {} as TRPCContext['env']['NOTIFICATIONS'],
          },
        };
        cloudAgentSession = mockContext.env.CLOUD_AGENT_SESSION as unknown as MockCAS;

        // Create caller with mocked context
        caller = appRouter.createCaller(mockContext);
      });

      describe('successful retrieval', () => {
        it('should return sanitized session metadata for owner', async () => {
          const sessionId: SessionId = 'agent_12345678-1234-1234-1234-123456789abc';
          const metadata = legacySessionMetadata({
            version: 123456789,
            sessionId,
            orgId: 'org-123',
            userId: 'test-user-123',
            timestamp: 123456789,
            kiloSessionId: 'a0000000-0000-4000-8000-000000000001',
            githubRepo: 'acme/repo',
            githubToken: 'secret-token-should-not-be-returned',
            gitUrl: undefined,
            gitToken: undefined,
            prompt: 'Build a feature',
            mode: 'code',
            model: 'claude-3-sonnet',
            autoCommit: true,
            upstreamBranch: 'main',
            envVars: { API_KEY: 'secret-value', DB_URL: 'postgres://localhost' },
            setupCommands: ['npm install', 'npm run build'],
            mcpServers: {
              puppeteer: { type: 'local', command: ['npx', '-y', '@mcp/puppeteer'] },
            },
            preparedAt: 1700000000000,
            initiatedAt: 1700000001000,
            callbackTarget: {
              url: 'https://callback.example.com/finalize',
              headers: { 'X-Internal-Secret': 'super-secret' },
            },
          });

          mockGetMetadata.mockResolvedValue(metadata);

          const result = await caller.getSession({ cloudAgentSessionId: sessionId });

          // Verify the result contains safe fields
          expect(result.sessionId).toBe(sessionId);
          expect(result.kiloSessionId).toBe('a0000000-0000-4000-8000-000000000001');
          expect(result.userId).toBe('test-user-123');
          expect(result.orgId).toBe('org-123');
          expect(result.githubRepo).toBe('acme/repo');
          expect(result.prompt).toBe('Build a feature');
          expect(result.mode).toBe('code');
          expect(result.model).toBe('claude-3-sonnet');
          expect(result.autoCommit).toBe(true);
          expect(result.upstreamBranch).toBe('main');
          expect(result.preparedAt).toBe(1700000000000);
          expect(result.initiatedAt).toBe(1700000001000);
          expect(result.timestamp).toBe(123456789);
          expect(result.version).toBe(123456789);

          // Verify secrets are NOT returned
          expect(result).not.toHaveProperty('githubToken');
          expect(result).not.toHaveProperty('gitToken');
          expect(result).not.toHaveProperty('envVars');
          expect(result).not.toHaveProperty('setupCommands');
          expect(result).not.toHaveProperty('mcpServers');
          // callbackTarget can carry service-to-service auth headers
          // (e.g. X-Internal-Secret) and must never be returned to the
          // session's owning user via this surface.
          expect(result).not.toHaveProperty('callbackTarget');

          // Verify DO was accessed with correct key
          expect(cloudAgentSession.idFromName).toHaveBeenCalledWith(`test-user-123:${sessionId}`);
        });

        it('does not expose stranded legacy execution rows as current session work', async () => {
          const sessionId: SessionId = 'agent_10101010-1010-1010-1010-101010101010';
          mockGetMetadata.mockResolvedValue(
            legacySessionMetadata({ version: 1, sessionId, userId: 'test-user-123', timestamp: 1 })
          );
          mockGetCurrentRuntimeExecution.mockResolvedValue({
            executionId: 'exc_stranded',
            status: 'running',
            startedAt: 1,
          });

          const result = await caller.getSession({ cloudAgentSessionId: sessionId });

          expect(result.execution).toBeNull();
        });

        it('projects current accepted message work into the existing execution-shaped field', async () => {
          const sessionId: SessionId = 'agent_20202020-2020-2020-2020-202020202020';
          mockGetMetadata.mockResolvedValue(
            legacySessionMetadata({ version: 1, sessionId, userId: 'test-user-123', timestamp: 1 })
          );
          mockGetCurrentMessageWork.mockResolvedValue({
            messageId: 'msg_018f1e2d3c4bHydrateMsgAbCdE',
            status: 'running',
            health: 'healthy',
          });

          const result = await caller.getSession({ cloudAgentSessionId: sessionId });

          expect(result.execution).toMatchObject({
            id: 'msg_018f1e2d3c4bHydrateMsgAbCdE',
            status: 'running',
            health: 'healthy',
          });
        });

        it('should work for personal account sessions (no orgId)', async () => {
          const sessionId: SessionId = 'agent_abcdef01-2345-6789-abcd-ef0123456789';
          const metadata = legacySessionMetadata({
            version: 123456789,
            sessionId,
            orgId: undefined, // Personal account
            userId: 'test-user-123',
            timestamp: 123456789,
            prompt: 'Test prompt',
            mode: 'plan',
            model: 'gpt-4',
          });

          mockGetMetadata.mockResolvedValue(metadata);

          const result = await caller.getSession({ cloudAgentSessionId: sessionId });

          expect(result.sessionId).toBe(sessionId);
          expect(result.orgId).toBeUndefined();
          expect(result.mode).toBe('plan');
        });

        it('should handle session with no optional fields', async () => {
          const sessionId: SessionId = 'agent_11111111-1111-1111-1111-111111111111';
          const metadata = legacySessionMetadata({
            version: 123456789,
            sessionId,
            userId: 'test-user-123',
            timestamp: 123456789,
          });

          mockGetMetadata.mockResolvedValue(metadata);

          const result = await caller.getSession({ cloudAgentSessionId: sessionId });

          expect(result.sessionId).toBe(sessionId);
          expect(result.kiloSessionId).toBeUndefined();
          expect(result.orgId).toBeUndefined();
          expect(result.githubRepo).toBeUndefined();
          expect(result.prompt).toBeUndefined();
          expect(result.mode).toBeUndefined();
          expect(result.model).toBeUndefined();
          expect(result.autoCommit).toBeUndefined();
          expect(result.preparedAt).toBeUndefined();
          expect(result.initiatedAt).toBeUndefined();
        });
      });

      describe('not found', () => {
        it('should return NOT_FOUND for non-existent session', async () => {
          const sessionId: SessionId = 'agent_00000000-0000-0000-0000-000000000000';

          mockGetMetadata.mockResolvedValue(null);

          await expect(caller.getSession({ cloudAgentSessionId: sessionId })).rejects.toThrow(
            TRPCError
          );
          await expect(caller.getSession({ cloudAgentSessionId: sessionId })).rejects.toThrow(
            'Session not found'
          );
        });
      });

      describe('cross-user access prevention', () => {
        it('should isolate sessions by userId via DO key', async () => {
          const sessionId: SessionId = 'agent_22222222-2222-2222-2222-222222222222';
          // Even if metadata exists for another user, the DO key includes userId
          // so user A cannot access user B's session

          // The DO is keyed by userId:sessionId, so a different user would get
          // a different DO instance that returns null
          mockGetMetadata.mockResolvedValue(null);

          await expect(caller.getSession({ cloudAgentSessionId: sessionId })).rejects.toThrow(
            'Session not found'
          );

          // Verify the DO was keyed with the authenticated user's ID
          expect(cloudAgentSession.idFromName).toHaveBeenCalledWith(`test-user-123:${sessionId}`);
        });
      });

      describe('lifecycle timestamps', () => {
        it('should return preparedAt when session is prepared but not initiated', async () => {
          const sessionId: SessionId = 'agent_33333333-3333-3333-3333-333333333333';
          const metadata = legacySessionMetadata({
            version: 123456789,
            sessionId,
            userId: 'test-user-123',
            timestamp: 123456789,
            preparedAt: 1700000000000,
            // initiatedAt is undefined - not yet initiated
          });

          mockGetMetadata.mockResolvedValue(metadata);

          const result = await caller.getSession({ cloudAgentSessionId: sessionId });

          expect(result.preparedAt).toBe(1700000000000);
          expect(result.initiatedAt).toBeUndefined();
        });

        it('should return both preparedAt and initiatedAt when session is initiated', async () => {
          const sessionId: SessionId = 'agent_44444444-4444-4444-4444-444444444444';
          const metadata = legacySessionMetadata({
            version: 123456789,
            sessionId,
            userId: 'test-user-123',
            timestamp: 123456789,
            preparedAt: 1700000000000,
            initiatedAt: 1700000001000,
          });

          mockGetMetadata.mockResolvedValue(metadata);

          const result = await caller.getSession({ cloudAgentSessionId: sessionId });

          expect(result.preparedAt).toBe(1700000000000);
          expect(result.initiatedAt).toBe(1700000001000);
        });
      });

      describe('authorization', () => {
        it('should require authentication', async () => {
          const unauthenticatedContext: TRPCContext = {
            userId: undefined,
            authToken: undefined,
            botId: undefined,
            env: mockContext.env,
          } as unknown as TRPCContext;

          const unauthenticatedCaller = appRouter.createCaller(unauthenticatedContext);

          await expect(
            unauthenticatedCaller.getSession({
              cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
            })
          ).rejects.toThrow('Authentication required');
        });
      });
    });

    describe('getSessionHealth procedure', () => {
      let mockContext: TRPCContext;
      let caller: ReturnType<typeof appRouter.createCaller>;
      let cloudAgentSession: MockCAS;
      let mockGetMetadata: ReturnType<typeof vi.fn>;
      let mockGetCurrentRuntimeExecution: ReturnType<typeof vi.fn>;
      let mockGetCurrentMessageWork: ReturnType<typeof vi.fn>;
      let mockListProcesses: ReturnType<typeof vi.fn>;

      beforeEach(() => {
        vi.clearAllMocks();

        mockGetMetadata = vi.fn();
        mockGetCurrentRuntimeExecution = vi.fn().mockResolvedValue(null);
        mockGetCurrentMessageWork = vi.fn().mockResolvedValue(null);
        mockListProcesses = vi.fn().mockResolvedValue([]);

        mockContext = {
          userId: 'test-user-123',
          authToken: 'test-token',
          botId: undefined,
          request: {} as Request,
          env: {
            Sandbox: {} as TRPCContext['env']['Sandbox'],
            SandboxSmall: {} as TRPCContext['env']['SandboxSmall'],
            SandboxDIND: {} as TRPCContext['env']['SandboxDIND'],
            CLOUD_AGENT_SESSION: {
              idFromName: vi.fn((id: string) => ({ id })),
              get: vi.fn(() => ({
                getMetadata: mockGetMetadata,
                getCurrentRuntimeExecution: mockGetCurrentRuntimeExecution,
                getCurrentMessageWork: mockGetCurrentMessageWork,
              })),
            } as unknown as TRPCContext['env']['CLOUD_AGENT_SESSION'],
            USER_KILO_FACADE: {} as TRPCContext['env']['USER_KILO_FACADE'],
            SESSION_INGEST: {
              fetch: vi.fn(),
            } as unknown as TRPCContext['env']['SESSION_INGEST'],
            R2_BUCKET: {} as TRPCContext['env']['R2_BUCKET'],
            CLOUD_AGENT_REPORT_QUEUE: {} as TRPCContext['env']['CLOUD_AGENT_REPORT_QUEUE'],
            GIT_TOKEN_SERVICE: {} as Env['GIT_TOKEN_SERVICE'],
            NEXTAUTH_SECRET: 'test-secret',
            INTERNAL_API_SECRET_PROD: {
              get: vi.fn().mockResolvedValue('test-secret'),
            } as unknown as TRPCContext['env']['INTERNAL_API_SECRET_PROD'],
            HYPERDRIVE: {
              connectionString: 'postgresql://test',
            } as unknown as TRPCContext['env']['HYPERDRIVE'],
            NOTIFICATIONS: {} as TRPCContext['env']['NOTIFICATIONS'],
          },
        };
        cloudAgentSession = mockContext.env.CLOUD_AGENT_SESSION as unknown as MockCAS;
        vi.mocked(getSandbox).mockReturnValue({
          listProcesses: mockListProcesses,
        } as unknown as ReturnType<typeof getSandbox>);
        caller = appRouter.createCaller(mockContext);
      });

      it('returns healthy sandbox and none execution health when no execution is active', async () => {
        const sessionId: SessionId = 'agent_88888888-8888-8888-8888-888888888888';
        const sandboxId = 'ses-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6';
        mockGetMetadata.mockResolvedValue(
          legacySessionMetadata({
            version: 123456789,
            sessionId,
            userId: 'test-user-123',
            timestamp: 123456789,
            sandboxId,
          })
        );

        const result = await caller.getSessionHealth({ cloudAgentSessionId: sessionId });

        expect(result).toEqual({
          cloudAgentSessionId: sessionId,
          sandboxId,
          sandboxStatus: 'healthy',
          executionHealth: 'none',
          activeExecutionId: undefined,
          activeExecutionStatus: undefined,
        });
        expect(cloudAgentSession.idFromName).toHaveBeenCalledWith(`test-user-123:${sessionId}`);
        expect(getSandbox).toHaveBeenCalledWith(mockContext.env.SandboxSmall, sandboxId);
        expect(mockListProcesses).toHaveBeenCalled();
      });

      it('reports pending message-native work as active through existing health fields', async () => {
        const sessionId: SessionId = 'agent_77777777-7777-7777-7777-777777777777';
        mockGetMetadata.mockResolvedValue(
          legacySessionMetadata({
            version: 123456789,
            sessionId,
            userId: 'test-user-123',
            timestamp: 123456789,
          })
        );
        mockGetCurrentMessageWork.mockResolvedValue({
          messageId: 'msg_018f1e2d3c4bHealthMsgAbCdEf',
          status: 'pending',
          health: 'healthy',
        });

        const result = await caller.getSessionHealth({ cloudAgentSessionId: sessionId });

        expect(result).toMatchObject({
          cloudAgentSessionId: sessionId,
          executionHealth: 'healthy',
          activeExecutionId: 'msg_018f1e2d3c4bHealthMsgAbCdEf',
          activeExecutionStatus: 'pending',
        });
      });

      it('reports accepted message-native work as running through existing health fields', async () => {
        const sessionId: SessionId = 'agent_66666666-6666-6666-6666-666666666666';
        mockGetMetadata.mockResolvedValue(
          legacySessionMetadata({
            version: 123456789,
            sessionId,
            userId: 'test-user-123',
            timestamp: 123456789,
          })
        );
        mockGetCurrentMessageWork.mockResolvedValue({
          messageId: 'msg_018f1e2d3c4bHealthRunAbCdEf',
          status: 'running',
          health: 'healthy',
        });

        const result = await caller.getSessionHealth({ cloudAgentSessionId: sessionId });

        expect(result).toMatchObject({
          executionHealth: 'healthy',
          activeExecutionId: 'msg_018f1e2d3c4bHealthRunAbCdEf',
          activeExecutionStatus: 'running',
        });
      });

      it('reports accepted message-native work as stale when its fenced liveness expired', async () => {
        const sessionId: SessionId = 'agent_55555555-5555-5555-5555-555555555555';
        mockGetMetadata.mockResolvedValue(
          legacySessionMetadata({
            version: 123456789,
            sessionId,
            userId: 'test-user-123',
            timestamp: 123456789,
          })
        );
        mockGetCurrentMessageWork.mockResolvedValue({
          messageId: 'msg_018f1e2d3c4bHealthOldAbCdEf',
          status: 'running',
          health: 'stale',
        });

        const result = await caller.getSessionHealth({ cloudAgentSessionId: sessionId });

        expect(result).toMatchObject({
          executionHealth: 'stale',
          activeExecutionId: 'msg_018f1e2d3c4bHealthOldAbCdEf',
          activeExecutionStatus: 'running',
        });
      });

      it('ignores stranded legacy execution rows when no current message work is active', async () => {
        const sessionId: SessionId = 'agent_99999999-9999-9999-9999-999999999999';
        mockGetMetadata.mockResolvedValue(
          legacySessionMetadata({
            version: 123456789,
            sessionId,
            userId: 'test-user-123',
            timestamp: 123456789,
          })
        );
        mockGetCurrentRuntimeExecution.mockResolvedValue({
          executionId: 'exc_stranded',
          status: 'running',
          startedAt: Date.now() - 20 * 60 * 1000,
          mode: 'code',
          streamingMode: 'websocket',
          lastHeartbeat: Date.now() - 11 * 60 * 1000,
        });

        const result = await caller.getSessionHealth({ cloudAgentSessionId: sessionId });

        expect(result).toMatchObject({ executionHealth: 'none', activeExecutionId: undefined });
      });

      it('reports current message work without consulting stranded execution freshness', async () => {
        const sessionId: SessionId = 'agent_99999999-9999-9999-9999-999999999999';
        const activeExecutionId = 'exc_stale_execution';
        mockGetMetadata.mockResolvedValue(
          legacySessionMetadata({
            version: 123456789,
            sessionId,
            orgId: 'org-123',
            userId: 'test-user-123',
            timestamp: 123456789,
          })
        );
        mockGetCurrentMessageWork.mockResolvedValue({
          messageId: activeExecutionId,
          status: 'running',
          health: 'healthy',
        });

        const result = await caller.getSessionHealth({ cloudAgentSessionId: sessionId });

        expect(result).toMatchObject({
          cloudAgentSessionId: sessionId,
          sandboxStatus: 'healthy',
          executionHealth: 'healthy',
          activeExecutionId,
          activeExecutionStatus: 'running',
        });
        expect(mockGetCurrentRuntimeExecution).not.toHaveBeenCalled();
      });

      it('returns NOT_FOUND for missing session metadata', async () => {
        const sessionId: SessionId = 'agent_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
        mockGetMetadata.mockResolvedValue(null);

        await expect(caller.getSessionHealth({ cloudAgentSessionId: sessionId })).rejects.toThrow(
          'Session not found'
        );
        expect(getSandbox).not.toHaveBeenCalled();
      });

      it('returns unreachable when sandbox process listing fails', async () => {
        const sessionId: SessionId = 'agent_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
        const sandboxId = 'ses-b1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6';
        mockGetMetadata.mockResolvedValue(
          legacySessionMetadata({
            version: 123456789,
            sessionId,
            userId: 'test-user-123',
            timestamp: 123456789,
            sandboxId,
            githubToken: 'secret-token-should-not-be-returned',
          })
        );
        mockListProcesses.mockRejectedValue(new Error('sandbox unavailable'));

        const result = await caller.getSessionHealth({ cloudAgentSessionId: sessionId });

        expect(result).toEqual({
          cloudAgentSessionId: sessionId,
          sandboxId,
          sandboxStatus: 'unreachable',
          executionHealth: 'none',
          activeExecutionId: undefined,
          activeExecutionStatus: undefined,
        });
        expect(result).not.toHaveProperty('githubToken');
      });
    });

    describe('getLatestAssistantMessage procedure', () => {
      let mockContext: TRPCContext;
      let caller: ReturnType<typeof appRouter.createCaller>;
      let cloudAgentSession: MockCAS;
      let mockGetMetadata: ReturnType<typeof vi.fn>;
      let mockGetLatestAssistantMessage: ReturnType<typeof vi.fn>;

      beforeEach(() => {
        vi.clearAllMocks();

        mockGetMetadata = vi.fn();
        mockGetLatestAssistantMessage = vi.fn();

        mockContext = {
          userId: 'test-user-123',
          authToken: 'test-token',
          botId: undefined,
          request: {} as Request,
          env: {
            Sandbox: {} as TRPCContext['env']['Sandbox'],
            SandboxSmall: {} as TRPCContext['env']['SandboxSmall'],
            SandboxDIND: {} as TRPCContext['env']['SandboxDIND'],
            CLOUD_AGENT_SESSION: {
              idFromName: vi.fn((id: string) => ({ id })),
              get: vi.fn(() => ({
                getMetadata: mockGetMetadata,
                getLatestAssistantMessage: mockGetLatestAssistantMessage,
              })),
            } as unknown as TRPCContext['env']['CLOUD_AGENT_SESSION'],
            USER_KILO_FACADE: {} as TRPCContext['env']['USER_KILO_FACADE'],
            SESSION_INGEST: {
              fetch: vi.fn(),
            } as unknown as TRPCContext['env']['SESSION_INGEST'],
            R2_BUCKET: {} as TRPCContext['env']['R2_BUCKET'],
            CLOUD_AGENT_REPORT_QUEUE: {} as TRPCContext['env']['CLOUD_AGENT_REPORT_QUEUE'],
            GIT_TOKEN_SERVICE: {} as Env['GIT_TOKEN_SERVICE'],
            NEXTAUTH_SECRET: 'test-secret',
            INTERNAL_API_SECRET_PROD: {
              get: vi.fn().mockResolvedValue('test-secret'),
            } as unknown as TRPCContext['env']['INTERNAL_API_SECRET_PROD'],
            HYPERDRIVE: {
              connectionString: 'postgresql://test',
            } as unknown as TRPCContext['env']['HYPERDRIVE'],
            NOTIFICATIONS: {} as TRPCContext['env']['NOTIFICATIONS'],
          },
        };
        cloudAgentSession = mockContext.env.CLOUD_AGENT_SESSION as unknown as MockCAS;
        caller = appRouter.createCaller(mockContext);
      });

      it('should return the latest assistant message for the owner', async () => {
        const sessionId: SessionId = 'agent_55555555-5555-5555-5555-555555555555';
        mockGetMetadata.mockResolvedValue(
          legacySessionMetadata({
            version: 123456789,
            sessionId,
            userId: 'test-user-123',
            timestamp: 123456789,
            kiloSessionId: 'ses_00000000000000000000000001',
          })
        );
        mockGetLatestAssistantMessage.mockResolvedValue({
          eventId: 12,
          timestamp: 1700000000000,
          info: {
            id: 'msg_00000000000000000000000001',
            role: 'assistant',
            sessionID: 'ses_00000000000000000000000001',
          },
          parts: [
            {
              id: 'part_00000000000000000000000001',
              messageID: 'msg_00000000000000000000000001',
              type: 'text',
              text: 'Done',
            },
          ],
        });

        const result = await caller.getLatestAssistantMessage({ cloudAgentSessionId: sessionId });

        expect(result).toEqual({
          cloudAgentSessionId: sessionId,
          message: {
            eventId: 12,
            timestamp: 1700000000000,
            info: {
              id: 'msg_00000000000000000000000001',
              role: 'assistant',
              sessionID: 'ses_00000000000000000000000001',
            },
            parts: [
              {
                id: 'part_00000000000000000000000001',
                messageID: 'msg_00000000000000000000000001',
                type: 'text',
                text: 'Done',
              },
            ],
          },
        });
        expect(cloudAgentSession.idFromName).toHaveBeenCalledWith(`test-user-123:${sessionId}`);
        expect(mockGetLatestAssistantMessage).toHaveBeenCalled();
      });

      it('should return null when the session has no assistant messages', async () => {
        const sessionId: SessionId = 'agent_66666666-6666-6666-6666-666666666666';
        mockGetMetadata.mockResolvedValue(
          legacySessionMetadata({
            version: 123456789,
            sessionId,
            userId: 'test-user-123',
            timestamp: 123456789,
            kiloSessionId: 'ses_00000000000000000000000001',
          })
        );
        mockGetLatestAssistantMessage.mockResolvedValue(null);

        await expect(
          caller.getLatestAssistantMessage({ cloudAgentSessionId: sessionId })
        ).resolves.toEqual({
          cloudAgentSessionId: sessionId,
          message: null,
        });
      });

      it('should return NOT_FOUND for a missing session', async () => {
        const sessionId: SessionId = 'agent_77777777-7777-7777-7777-777777777777';
        mockGetMetadata.mockResolvedValue(null);

        await expect(
          caller.getLatestAssistantMessage({ cloudAgentSessionId: sessionId })
        ).rejects.toThrow('Session not found');
        expect(mockGetLatestAssistantMessage).not.toHaveBeenCalled();
      });

      it('should require authentication', async () => {
        const unauthenticatedContext: TRPCContext = {
          userId: undefined,
          authToken: undefined,
          botId: undefined,
          env: mockContext.env,
        } as unknown as TRPCContext;

        const unauthenticatedCaller = appRouter.createCaller(unauthenticatedContext);

        await expect(
          unauthenticatedCaller.getLatestAssistantMessage({
            cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
          })
        ).rejects.toThrow('Authentication required');
      });
    });
  });
});

describe('getMessageResult procedure', () => {
  const sessionId: SessionId = 'agent_12345678-1234-1234-1234-123456789abc';
  const messageId = 'msg_018f1e2d3c4bAbCdEfGhIjKlMn';
  let mockContext: TRPCContext;
  let caller: ReturnType<typeof appRouter.createCaller>;
  let cloudAgentSession: MockCAS;
  let mockGetMessageResult: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMessageResult = vi.fn().mockResolvedValue({
      type: 'found',
      result: {
        cloudAgentSessionId: sessionId,
        messageId,
        status: 'completed',
        createdAt: 1,
        terminalAt: 2,
        assistant: { messageId: 'assistant_done', text: 'done' },
      },
    });
    mockContext = {
      userId: 'test-user-123',
      authToken: 'test-token',
      botId: undefined,
      request: {} as Request,
      env: {
        CLOUD_AGENT_SESSION: {
          idFromName: vi.fn((id: string) => ({ id })),
          get: vi.fn(() => ({ getMessageResult: mockGetMessageResult })),
        } as unknown as TRPCContext['env']['CLOUD_AGENT_SESSION'],
      } as unknown as TRPCContext['env'],
    };
    cloudAgentSession = mockContext.env.CLOUD_AGENT_SESSION as unknown as MockCAS;
    caller = appRouter.createCaller(mockContext);
  });

  it('returns an ownership-isolated safe exact message result with one Durable Object RPC', async () => {
    await expect(
      caller.getMessageResult({ cloudAgentSessionId: sessionId, messageId })
    ).resolves.toEqual({
      cloudAgentSessionId: sessionId,
      messageId,
      status: 'completed',
      createdAt: 1,
      terminalAt: 2,
      assistant: { messageId: 'assistant_done', text: 'done' },
    });
    expect(cloudAgentSession.idFromName).toHaveBeenCalledWith(`test-user-123:${sessionId}`);
    expect(mockGetMessageResult).toHaveBeenCalledOnce();
    expect(mockGetMessageResult).toHaveBeenCalledWith(messageId);
  });

  it('returns Session not found when the Durable Object has no metadata', async () => {
    mockGetMessageResult.mockResolvedValue({ type: 'session-not-found' });
    await expect(
      caller.getMessageResult({ cloudAgentSessionId: sessionId, messageId })
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Session not found' });
  });

  it('returns Message not found for an unknown message ID', async () => {
    mockGetMessageResult.mockResolvedValue({ type: 'message-not-found' });
    await expect(
      caller.getMessageResult({ cloudAgentSessionId: sessionId, messageId })
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Message not found' });
  });

  it('fails closed when persisted message state is invalid', async () => {
    mockGetMessageResult.mockResolvedValue({ type: 'state-invalid' });
    await expect(
      caller.getMessageResult({ cloudAgentSessionId: sessionId, messageId })
    ).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Message result unavailable',
    });
  });

  it('requires authentication', async () => {
    const unauthenticatedCaller = appRouter.createCaller({
      ...mockContext,
      userId: undefined,
      authToken: undefined,
    } as unknown as TRPCContext);
    await expect(
      unauthenticatedCaller.getMessageResult({ cloudAgentSessionId: sessionId, messageId })
    ).rejects.toThrow('Authentication required');
  });

  it('rejects extra sensitive RPC response fields at the output boundary', async () => {
    mockGetMessageResult.mockResolvedValue({
      type: 'found',
      result: {
        cloudAgentSessionId: sessionId,
        messageId,
        status: 'failed',
        createdAt: 1,
        error: 'private raw error',
      },
    });
    await expect(
      caller.getMessageResult({ cloudAgentSessionId: sessionId, messageId })
    ).rejects.toThrow();
  });
});

describe('router terminal procedures', () => {
  it('creates a terminal through the session Durable Object', async () => {
    const createTerminal = vi.fn().mockResolvedValue({
      success: true,
      data: {
        pty: {
          id: 'pty_123',
          title: 'Workspace terminal',
          command: '/bin/sh',
          args: [],
          cwd: '/workspace/repo',
          status: 'running',
          pid: 123,
        },
      },
    });
    const cloudAgentSession: MockCAS = {
      idFromName: vi.fn().mockReturnValue('do-id'),
      get: vi.fn().mockReturnValue({ createTerminal }),
    };
    const context = {
      userId: 'test-user-123',
      authToken: 'token',
      botId: undefined,
      request: new Request('http://test.local'),
      env: {
        CLOUD_AGENT_SESSION: cloudAgentSession,
      },
    } as unknown as TRPCContext;
    const caller = appRouter.createCaller(context);
    const sessionId = 'agent_12345678-1234-1234-1234-123456789abc' as SessionId;

    const result = await caller.createTerminal({
      cloudAgentSessionId: sessionId,
      cols: 120,
      rows: 32,
    });

    expect(result).toEqual({
      pty: {
        id: 'pty_123',
        title: 'Workspace terminal',
        command: '/bin/sh',
        args: [],
        cwd: '/workspace/repo',
        status: 'running',
        pid: 123,
      },
    });
    expect(cloudAgentSession.idFromName).toHaveBeenCalledWith(`test-user-123:${sessionId}`);
    expect(createTerminal).toHaveBeenCalledWith({ cols: 120, rows: 32 });
  });
});

describe('legacy V2 execution response compatibility', () => {
  const validSessionId = 'agent_12345678-1234-1234-1234-123456789abc';
  const acceptedMessageId = 'msg_018f1e2d3c4bAbCdEfGhIjKlMn';

  beforeEach(() => {
    preflightExistingPromptModelMock.mockReset();
    preflightPreparedInitialPromptModelMock.mockReset();
    preflightExistingPromptModelMock.mockResolvedValue(undefined);
    preflightPreparedInitialPromptModelMock.mockResolvedValue(undefined);
  });

  function createLegacyExecutionCaller() {
    const admitPreparedInitialMessage = vi.fn().mockResolvedValue({
      success: true,
      outcome: 'queued',
      compatibilityDelivery: 'queued',
      messageId: acceptedMessageId,
    });
    const admitSubmittedMessage = vi.fn().mockResolvedValue({
      success: true,
      outcome: 'queued',
      compatibilityDelivery: 'queued',
      messageId: acceptedMessageId,
    });
    const hasMessageAdmission = vi.fn().mockResolvedValue(false);
    const replayPreparedInitialMessage = vi.fn().mockResolvedValue(undefined);
    recordCloudAgentSessionFailureMock.mockReset().mockResolvedValue({});
    const context = {
      userId: 'test-user-123',
      authToken: 'test-token',
      botId: undefined,
      request: new Request('https://cloud-agent-next.test/trpc'),
      env: {
        CLOUD_AGENT_SESSION: {
          idFromName: vi.fn((id: string) => ({ id })),
          get: vi.fn(() => ({
            admitPreparedInitialMessage,
            admitSubmittedMessage,
            hasMessageAdmission,
            replayPreparedInitialMessage,
          })),
        },
        SESSION_INGEST: {},
      },
    } as unknown as TRPCContext;

    return {
      caller: appRouter.createCaller(context),
      admitPreparedInitialMessage,
      admitSubmittedMessage,
      hasMessageAdmission,
      replayPreparedInitialMessage,
      recordCloudAgentSessionFailure: recordCloudAgentSessionFailureMock,
    };
  }

  it('initiateFromKilocodeSessionV2 returns executionId as the queued messageId', async () => {
    const { caller, recordCloudAgentSessionFailure } = createLegacyExecutionCaller();

    const result = await caller.initiateFromKilocodeSessionV2({
      cloudAgentSessionId: validSessionId,
    });

    expect(result.messageId).toBe(acceptedMessageId);
    expect(result.executionId).toBe(acceptedMessageId);
    expect(recordCloudAgentSessionFailure).not.toHaveBeenCalled();
  });

  it('does not write a setup failure for queued legacy admission', async () => {
    const { caller, recordCloudAgentSessionFailure } = createLegacyExecutionCaller();

    const result = await caller.initiateFromKilocodeSessionV2({
      cloudAgentSessionId: validSessionId,
    });

    expect(result.messageId).toBe(acceptedMessageId);
    expect(result.delivery).toBe('queued');
    expect(recordCloudAgentSessionFailure).not.toHaveBeenCalled();
  });

  it('reports failed legacy initial admission without asserting metadata readiness', async () => {
    const { caller, admitPreparedInitialMessage, recordCloudAgentSessionFailure } =
      createLegacyExecutionCaller();
    admitPreparedInitialMessage.mockResolvedValue({
      success: false,
      code: 'PENDING_QUEUE_FULL',
      error: 'queue full',
    });

    await expect(
      caller.initiateFromKilocodeSessionV2({ cloudAgentSessionId: validSessionId })
    ).rejects.toThrow('queue full');

    expect(recordCloudAgentSessionFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        failure: { stage: 'initial_admission', code: 'initial_queue_full' },
      })
    );
  });

  it('reports an unknown legacy initial admission RPC outcome', async () => {
    const { caller, admitPreparedInitialMessage, recordCloudAgentSessionFailure } =
      createLegacyExecutionCaller();
    admitPreparedInitialMessage.mockRejectedValue(new Error('rpc result unavailable'));

    await expect(
      caller.initiateFromKilocodeSessionV2({ cloudAgentSessionId: validSessionId })
    ).rejects.toThrow('rpc result unavailable');

    expect(recordCloudAgentSessionFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        failure: { stage: 'transport', code: 'do_rpc_outcome_unknown' },
      })
    );
  });

  it('preserves failed legacy admission when failure fact persistence fails', async () => {
    const { caller, admitPreparedInitialMessage, recordCloudAgentSessionFailure } =
      createLegacyExecutionCaller();
    admitPreparedInitialMessage.mockResolvedValue({
      success: false,
      code: 'PENDING_QUEUE_FULL',
      error: 'queue full',
    });
    recordCloudAgentSessionFailure.mockRejectedValueOnce(new Error('reporting unavailable'));

    await expect(
      caller.initiateFromKilocodeSessionV2({ cloudAgentSessionId: validSessionId })
    ).rejects.toThrow('queue full');
  });

  it('preserves unknown legacy admission when failure fact persistence fails', async () => {
    const { caller, admitPreparedInitialMessage, recordCloudAgentSessionFailure } =
      createLegacyExecutionCaller();
    admitPreparedInitialMessage.mockRejectedValue(new Error('rpc result unavailable'));
    recordCloudAgentSessionFailure.mockRejectedValueOnce(new Error('reporting unavailable'));

    await expect(
      caller.initiateFromKilocodeSessionV2({ cloudAgentSessionId: validSessionId })
    ).rejects.toThrow('rpc result unavailable');
  });

  it('rejects unavailable prepared prompt models before initial admission', async () => {
    const { caller, admitPreparedInitialMessage } = createLegacyExecutionCaller();
    preflightPreparedInitialPromptModelMock.mockRejectedValue(
      new TRPCError({ code: 'BAD_REQUEST', message: 'Selected model is not available' })
    );

    await expect(
      caller.initiateFromKilocodeSessionV2({ cloudAgentSessionId: validSessionId })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(admitPreparedInitialMessage).not.toHaveBeenCalled();
  });

  it('returns an admitted prepared initial retry without repeating model preflight', async () => {
    const { caller, replayPreparedInitialMessage } = createLegacyExecutionCaller();
    replayPreparedInitialMessage.mockResolvedValue({
      success: true,
      outcome: 'queued',
      compatibilityDelivery: 'queued',
      messageId: acceptedMessageId,
    });
    preflightPreparedInitialPromptModelMock.mockRejectedValue(
      new TRPCError({ code: 'BAD_REQUEST', message: 'Selected model is no longer available' })
    );

    const result = await caller.initiateFromKilocodeSessionV2({
      cloudAgentSessionId: validSessionId,
    });

    expect(result).toMatchObject({ executionId: acceptedMessageId, delivery: 'queued' });
    expect(replayPreparedInitialMessage).toHaveBeenCalledTimes(1);
    expect(preflightPreparedInitialPromptModelMock).not.toHaveBeenCalled();
  });

  it('sendMessageV2 preserves sent delivery when a runtime-accepted admission is replayed', async () => {
    const { caller, admitSubmittedMessage } = createLegacyExecutionCaller();
    admitSubmittedMessage.mockResolvedValue({
      success: true,
      outcome: 'queued',
      compatibilityDelivery: 'sent',
      messageId: acceptedMessageId,
    });

    const result = await caller.sendMessageV2({
      cloudAgentSessionId: validSessionId,
      messageId: acceptedMessageId,
      prompt: 'follow up',
      mode: 'code',
      model: 'test-model',
    });

    expect(result).toMatchObject({
      status: 'started',
      delivery: 'sent',
      executionId: acceptedMessageId,
    });
  });

  it('sendMessageV2 returns executionId as the accepted messageId', async () => {
    const { caller } = createLegacyExecutionCaller();

    const result = await caller.sendMessageV2({
      cloudAgentSessionId: validSessionId,
      prompt: 'follow up',
      mode: 'code',
      model: 'test-model',
    });

    expect(result.messageId).toBe(acceptedMessageId);
    expect(result.executionId).toBe(acceptedMessageId);
  });

  it('returns an admitted V2 prompt retry without repeating model preflight', async () => {
    const { caller, hasMessageAdmission } = createLegacyExecutionCaller();
    hasMessageAdmission.mockResolvedValue(true);
    preflightExistingPromptModelMock.mockRejectedValue(
      new TRPCError({ code: 'BAD_REQUEST', message: 'Selected model is no longer available' })
    );

    const result = await caller.sendMessageV2({
      cloudAgentSessionId: validSessionId,
      messageId: acceptedMessageId,
      prompt: 'follow up',
      mode: 'code',
      model: 'test-model',
    });

    expect(result).toMatchObject({ executionId: acceptedMessageId, delivery: 'queued' });
    expect(hasMessageAdmission).toHaveBeenCalledWith(acceptedMessageId);
    expect(preflightExistingPromptModelMock).not.toHaveBeenCalled();
  });

  it('rejects unavailable prompt sends before V2 message admission', async () => {
    const { caller, admitSubmittedMessage } = createLegacyExecutionCaller();
    preflightExistingPromptModelMock.mockRejectedValue(
      new TRPCError({ code: 'BAD_REQUEST', message: 'Selected model is not available' })
    );

    await expect(
      caller.sendMessageV2({
        cloudAgentSessionId: validSessionId,
        prompt: 'follow up',
        mode: 'code',
        model: 'missing/model',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(admitSubmittedMessage).not.toHaveBeenCalled();
  });

  it('rejects unavailable unified prompt sends before message admission', async () => {
    const { caller, admitSubmittedMessage } = createLegacyExecutionCaller();
    preflightExistingPromptModelMock.mockRejectedValue(
      new TRPCError({ code: 'BAD_REQUEST', message: 'Selected model is not available' })
    );

    await expect(
      caller.send({
        cloudAgentSessionId: validSessionId,
        message: { prompt: 'follow up' },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(admitSubmittedMessage).not.toHaveBeenCalled();
  });

  it('returns an admitted unified message retry without repeating model preflight', async () => {
    const { caller, hasMessageAdmission, admitSubmittedMessage } = createLegacyExecutionCaller();
    hasMessageAdmission.mockResolvedValue(true);
    preflightExistingPromptModelMock.mockRejectedValue(
      new TRPCError({ code: 'BAD_REQUEST', message: 'Selected model is no longer available' })
    );

    const result = await caller.send({
      cloudAgentSessionId: validSessionId,
      message: { id: acceptedMessageId, prompt: 'follow up' },
    });

    expect(result).toMatchObject({ messageId: acceptedMessageId, delivery: 'queued' });
    expect(hasMessageAdmission).toHaveBeenCalledWith(acceptedMessageId);
    expect(preflightExistingPromptModelMock).not.toHaveBeenCalled();
    expect(admitSubmittedMessage).toHaveBeenCalledTimes(1);
  });

  it('sendMessageV2 normalizes legacy image descriptors before queueing', async () => {
    const { caller, admitSubmittedMessage } = createLegacyExecutionCaller();
    const images = {
      path: '123e4567-e89b-12d3-a456-426614174000',
      files: ['123e4567-e89b-12d3-a456-426614174001.png'],
    };

    await caller.sendMessageV2({
      cloudAgentSessionId: validSessionId,
      prompt: 'follow up with old client image',
      mode: 'code',
      model: 'test-model',
      images,
    });

    expect(admitSubmittedMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        turn: expect.objectContaining({ attachments: images }),
      })
    );
  });

  it('sendMessageV2 accepts deprecated token fields without queueing token overrides', async () => {
    const { caller, admitSubmittedMessage } = createLegacyExecutionCaller();

    await caller.sendMessageV2({
      cloudAgentSessionId: validSessionId,
      prompt: 'follow up',
      mode: 'code',
      model: 'test-model',
      githubToken: 'deprecated-github-token',
      gitToken: 'deprecated-git-token',
    });

    const request = admitSubmittedMessage.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      turn: {
        type: 'prompt',
        id: undefined,
        prompt: 'follow up',
        attachments: undefined,
      },
    });
    expect(request).not.toHaveProperty('tokenOverrides');
  });

  it('sendMessageV2 queues structured commands without flattening them into prompt text', async () => {
    const { caller, admitSubmittedMessage } = createLegacyExecutionCaller();

    await caller.sendMessageV2({
      cloudAgentSessionId: validSessionId,
      payload: {
        type: 'command',
        command: 'compact',
        arguments: '--aggressive',
      },
    });

    expect(admitSubmittedMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        turn: {
          type: 'command',
          id: undefined,
          command: 'compact',
          arguments: '--aggressive',
        },
      })
    );
    expect(preflightExistingPromptModelMock).not.toHaveBeenCalled();
  });
});
