import { describe, expect, it } from 'vitest';
import { sessionAttachPayloadSchema } from './sandbox-control-protocol.js';
import {
  isWrapperSessionReadyRequest,
  type WrapperSessionReadyRequest,
} from './wrapper-bootstrap.js';
import {
  MAX_ATTACH_ENV_KEYS,
  MAX_PROFILE_ENV_VARS,
  RESERVED_ENV_VARS_MESSAGE,
} from './runtime-environment.js';

function attach(env: Record<string, string>) {
  return sessionAttachPayloadSchema.safeParse({ env });
}

function profileEnv(count: number): Record<string, string> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [`KEY_${index}`, 'value']));
}

describe('sessionAttachPayloadSchema env', () => {
  it('accepts a plain environment variable', () => {
    expect(attach({ API_KEY: 'value' }).success).toBe(true);
  });

  it('accepts only names the platform does not set', () => {
    for (const key of ['SESSION_HOME', 'SESSION_ID', 'pnpm_config_store_dir']) {
      const result = attach({ [key]: '/custom' });
      expect(result.success, key).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe(RESERVED_ENV_VARS_MESSAGE);
      }
    }
  });

  it('accepts a full profile plus the credential names the preparation adds', () => {
    expect(
      attach({
        ...profileEnv(MAX_PROFILE_ENV_VARS),
        KILOCODE_TOKEN: 'token',
        GH_TOKEN: 'token',
        GITLAB_TOKEN: 'token',
      }).success
    ).toBe(true);
    expect(attach(profileEnv(MAX_ATTACH_ENV_KEYS)).success).toBe(true);
  });

  it('rejects one key over the attach env cap', () => {
    const result = attach(profileEnv(MAX_ATTACH_ENV_KEYS + 1));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(
        `Maximum ${MAX_ATTACH_ENV_KEYS} environment variables allowed`
      );
    }
  });
});

function readyRequest(env: Record<string, string>): WrapperSessionReadyRequest {
  return {
    agentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
    userId: 'user_test',
    sandboxId: 'usr-test',
    kiloSessionId: 'kilo_sess_1',
    workspace: {
      workspacePath: '/workspace/app',
      sessionHome: '/home/worktree-a',
      branchName: 'main',
    },
    materialized: { env },
    session: {
      ingestUrl: 'wss://worker.example.com/sessions/user_test/agent/ingest',
      workerAuthToken: 'wrapper-dispatch-ticket',
      wrapperRunId: 'wr_test',
      wrapperGeneration: 1,
      wrapperConnectionId: 'conn_test',
    },
  };
}

describe('isWrapperSessionReadyRequest materialized env', () => {
  it('accepts a request whose env carries the profile names', () => {
    expect(isWrapperSessionReadyRequest(readyRequest({ KILOCODE_TOKEN: 'token' }))).toBe(true);
  });

  it('requires a request whose env leaves the platform names to the platform', () => {
    for (const key of ['SESSION_HOME', 'SESSION_ID', 'pnpm_config_store_dir', 'HOME']) {
      expect(isWrapperSessionReadyRequest(readyRequest({ [key]: '/custom' })), key).toBe(false);
    }
  });
});
