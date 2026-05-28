import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchSessionMetadata } from '../session-service.js';
import { assertKiloModelAvailable } from '../model-validation.js';
import type { PersistenceEnv, CloudAgentSessionState } from '../persistence/types.js';
import {
  preflightExistingPromptModel,
  preflightPreparedInitialPromptModel,
} from './model-preflight.js';

vi.mock('../session-service.js', () => ({ fetchSessionMetadata: vi.fn() }));
vi.mock('../model-validation.js', () => ({ assertKiloModelAvailable: vi.fn() }));

const metadata: CloudAgentSessionState = {
  metadataSchemaVersion: 2,
  identity: {
    sessionId: 'agent_12345678-1234-1234-1234-123456789abc',
    userId: 'user-1',
    orgId: 'org-1',
    createdOnPlatform: 'cloud-agent-web',
  },
  auth: { kilocodeToken: 'stored-token' },
  agent: { model: 'stored/model' },
  initialMessage: {
    turn: { type: 'prompt', prompt: 'start' },
  },
  lifecycle: { version: 1, timestamp: 1 },
};

const env = {} as PersistenceEnv;

describe('model preflight for stored sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchSessionMetadata).mockResolvedValue(metadata);
    vi.mocked(assertKiloModelAvailable).mockResolvedValue(undefined);
  });

  it('validates an explicit continuation model in stored runtime context', async () => {
    await preflightExistingPromptModel({
      env,
      userId: 'user-1',
      cloudAgentSessionId: metadata.identity.sessionId,
      requestedModel: 'override/model',
      procedure: 'send',
    });

    expect(assertKiloModelAvailable).toHaveBeenCalledWith({
      env,
      submittedModel: 'override/model',
      originalToken: 'stored-token',
      originalOrganizationId: 'org-1',
      createdOnPlatform: 'cloud-agent-web',
      procedure: 'send',
    });
  });

  it('validates the stored default when a prompt continuation has no override', async () => {
    await preflightExistingPromptModel({
      env,
      userId: 'user-1',
      cloudAgentSessionId: metadata.identity.sessionId,
      procedure: 'send',
    });

    expect(assertKiloModelAvailable).toHaveBeenCalledWith(
      expect.objectContaining({ submittedModel: 'stored/model' })
    );
  });

  it('preserves session-not-found behavior before validating', async () => {
    vi.mocked(fetchSessionMetadata).mockResolvedValue(null);

    await expect(
      preflightExistingPromptModel({
        env,
        userId: 'user-1',
        cloudAgentSessionId: metadata.identity.sessionId,
        procedure: 'send',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Session not found' });
    expect(assertKiloModelAvailable).not.toHaveBeenCalled();
  });

  it('validates prepared prompt initiation using its stored default', async () => {
    await preflightPreparedInitialPromptModel({
      env,
      userId: 'user-1',
      cloudAgentSessionId: metadata.identity.sessionId,
      procedure: 'initiateFromKilocodeSessionV2',
    });

    expect(assertKiloModelAvailable).toHaveBeenCalledWith(
      expect.objectContaining({ submittedModel: 'stored/model' })
    );
  });

  it('leaves command-based prepared initiation to runtime validation', async () => {
    vi.mocked(fetchSessionMetadata).mockResolvedValue({
      ...metadata,
      initialMessage: {
        turn: { type: 'command', command: 'compact', arguments: '' },
      },
    });

    await preflightPreparedInitialPromptModel({
      env,
      userId: 'user-1',
      cloudAgentSessionId: metadata.identity.sessionId,
      procedure: 'initiateFromKilocodeSessionV2',
    });

    expect(assertKiloModelAvailable).not.toHaveBeenCalled();
  });

  it('leaves incomplete legacy prepared metadata for admission to reject', async () => {
    vi.mocked(fetchSessionMetadata).mockResolvedValue({
      ...metadata,
      initialMessage: { id: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn' },
    });

    await preflightPreparedInitialPromptModel({
      env,
      userId: 'user-1',
      cloudAgentSessionId: metadata.identity.sessionId,
      procedure: 'initiateFromKilocodeSessionV2',
    });

    expect(assertKiloModelAvailable).not.toHaveBeenCalled();
  });
});
