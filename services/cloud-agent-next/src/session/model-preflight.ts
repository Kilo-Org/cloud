import { TRPCError } from '@trpc/server';
import { assertKiloModelAvailable } from '../model-validation.js';
import type { CloudAgentSessionState, PersistenceEnv } from '../persistence/types.js';
import { fetchSessionMetadata } from '../session-service.js';
import { resolveSessionStub } from '../sandbox-session/session-stub.js';
import { withDORetry } from '../utils/do-retry.js';
import { hasModernRuntimeAuthorization } from './runtime-authorization-persistence.js';

type StoredSessionPreflightInput = {
  env: PersistenceEnv;
  userId: string;
  cloudAgentSessionId: string;
  procedure: string;
};

type ExistingPromptModelPreflightInput = StoredSessionPreflightInput & {
  requestedModel?: string;
};

async function requireSessionMetadata(
  input: StoredSessionPreflightInput
): Promise<CloudAgentSessionState> {
  const metadata = await fetchSessionMetadata(input.env, input.userId, input.cloudAgentSessionId);
  if (!metadata) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' });
  }
  return metadata;
}

async function assertModelFromStoredContext(
  input: StoredSessionPreflightInput,
  metadata: CloudAgentSessionState,
  submittedModel: string | undefined
): Promise<void> {
  let token = metadata.auth.kilocodeToken;
  if (hasModernRuntimeAuthorization(metadata)) {
    // The owning DO renews short-lived backing tokens within the existing delegation.
    const runtimeToken = await withDORetry(
      () => resolveSessionStub(input.env, input.userId, input.cloudAgentSessionId),
      stub => stub.getRuntimeToken(),
      'getRuntimeTokenForModelPreflight'
    );
    if (!runtimeToken) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Model catalog authentication unavailable',
      });
    }
    token = runtimeToken;
  }
  await assertKiloModelAvailable({
    env: input.env,
    submittedModel,
    originalToken: token,
    originalOrganizationId: metadata.identity.orgId,
    createdOnPlatform: metadata.identity.createdOnPlatform,
    procedure: input.procedure,
  });
}

export async function preflightExistingPromptModel(
  input: ExistingPromptModelPreflightInput
): Promise<void> {
  const metadata = await requireSessionMetadata(input);
  await assertModelFromStoredContext(
    input,
    metadata,
    input.requestedModel ?? metadata.agent?.model
  );
}

export async function preflightPreparedInitialPromptModel(
  input: StoredSessionPreflightInput
): Promise<void> {
  const metadata = await requireSessionMetadata(input);
  const turn = metadata.initialMessage?.turn;
  if (turn?.type === 'command') return;
  // Admission retains the existing `No prompt provided` error for incomplete legacy metadata.
  if (turn?.type !== 'prompt' && metadata.initialMessage?.prompt === undefined) return;
  await assertModelFromStoredContext(input, metadata, metadata.agent?.model);
}
