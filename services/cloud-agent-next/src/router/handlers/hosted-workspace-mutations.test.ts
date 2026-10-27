import { describe, expect, it } from 'vitest';

import { appRouter } from '../../router.js';
import {
  CreateHostedWorkspaceInput,
  DeleteHostedWorkspaceSessionInput,
  hostedWorkspaceCreateRequest,
} from './hosted-workspace-mutations.js';
import { CreateHostedWorkspaceSessionInput } from './session-worktree.js';

const workspaceId = 'worktree_11111111-1111-4111-8111-111111111111';
const cloudAgentSessionId = 'workspace_11111111-1111-4111-8111-111111111111';
const kiloSessionId = 'ses_12345678901234567890123456';

const validCreate = {
  operationKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  clientProvenance: 'agent-manager',
  repository: { type: 'github', repo: 'Kilo-Org/cloud', branch: 'main' },
  profile: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
  message: { prompt: 'Start the workspace' },
  agent: { mode: 'code', model: 'anthropic/claude-sonnet-4' },
};

describe('hosted workspace mutation inputs', () => {
  it('registers the new mutations on the app router', () => {
    expect(appRouter.createHostedWorkspace).toBeDefined();
    expect(appRouter.createHostedWorkspaceSession).toBeDefined();
    expect(appRouter.deleteHostedWorkspaceSession).toBeDefined();
  });

  it('requires an explicit profile for a new workspace', () => {
    expect(CreateHostedWorkspaceInput.safeParse(validCreate).success).toBe(true);
    expect(CreateHostedWorkspaceInput.safeParse({ ...validCreate, profile: {} }).success).toBe(
      false
    );
    expect(
      CreateHostedWorkspaceInput.safeParse({ ...validCreate, profile: undefined }).success
    ).toBe(false);
  });

  it('rejects a non-agent-manager provenance for new-workspace creation', () => {
    expect(
      CreateHostedWorkspaceInput.safeParse({ ...validCreate, clientProvenance: 'browser' }).success
    ).toBe(false);
  });

  it('requires an operation key for new-workspace creation', () => {
    expect(
      CreateHostedWorkspaceInput.safeParse({ ...validCreate, operationKey: undefined }).success
    ).toBe(false);
  });

  it('forwards a client-proposed Kilo session id into registration', () => {
    const input = CreateHostedWorkspaceInput.parse({ ...validCreate, kiloSessionId });

    expect(hostedWorkspaceCreateRequest(input).options?.kiloSessionId).toBe(kiloSessionId);
  });

  it('does not accept workspace-wide overrides when adding a sibling', () => {
    const valid = {
      workspaceId,
      operationKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      clientProvenance: 'agent-manager',
      message: { prompt: 'Second chat' },
      agent: { mode: 'code', model: 'anthropic/claude-sonnet-4' },
    };
    expect(CreateHostedWorkspaceSessionInput.safeParse(valid).success).toBe(true);
    expect(
      CreateHostedWorkspaceSessionInput.safeParse({
        ...valid,
        repository: { type: 'github', repo: 'Kilo-Org/other' },
      }).success
    ).toBe(false);
    expect(CreateHostedWorkspaceSessionInput.safeParse({ ...valid, branch: 'other' }).success).toBe(
      false
    );
    expect(
      CreateHostedWorkspaceSessionInput.safeParse({ ...valid, profile: { id: workspaceId } })
        .success
    ).toBe(false);
  });

  it('requires a workspace-scoped cloud session id for deletion', () => {
    expect(
      DeleteHostedWorkspaceSessionInput.safeParse({
        workspaceId,
        sessionId: cloudAgentSessionId,
        operationKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }).success
    ).toBe(true);
    expect(
      DeleteHostedWorkspaceSessionInput.safeParse({
        workspaceId,
        sessionId: kiloSessionId,
        operationKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }).success
    ).toBe(false);
  });
});
