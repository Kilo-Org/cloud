import { describe, expect, it } from 'vitest';

import { type KiloSessionId, type UserWebConnection } from 'cloud-agent-sdk';
// kilocode_change - K1/C2: runtime imports via the narrow subpath alias —
// see the matching comment in remote-instance-spawn-classifier.ts and
// vitest.config.ts for why the full `cloud-agent-sdk` barrel is unsafe here.
import { CommandDeliveredError, UserWebCommandError } from 'cloud-agent-sdk/user-web-connection';

// kilocode_change - K1/C2: imported from the classifier module, not
// `use-remote-instance-spawn.ts` — that file's `useRemoteInstanceSpawn` hook
// pulls in `useUserWebConnection`, which transitively loads React
// Native/Expo modules containing Flow syntax the Node vitest environment
// cannot parse. See that file's header comment for the full explanation.
import {
  classifyCreateSessionResult,
  createSessionSpawner,
  type CreateSessionSpawner,
  SESSION_OWNER_NOT_FOUND_LITERAL,
} from './remote-instance-spawn-classifier';

const VALID_SESSION_ID = 'ses_12345678901234567890123456' as KiloSessionId;

function makeConnection(impl: UserWebConnection['sendCommandToConnection']): UserWebConnection {
  return {
    sendCommandToConnection: impl,
  } as unknown as UserWebConnection;
}

describe('classifyCreateSessionResult', () => {
  it('returns ready with the session id when a valid v1 envelope resolves', () => {
    const result = classifyCreateSessionResult({
      status: 'fulfilled',
      value: { protocolVersion: 1, sessionID: VALID_SESSION_ID },
    });
    expect(result).toEqual({ status: 'ready', sessionID: VALID_SESSION_ID });
  });

  it('returns nonRetryable for a resolved-but-malformed response', () => {
    const result = classifyCreateSessionResult({
      status: 'fulfilled',
      value: { nope: true },
    });
    expect(result).toEqual({
      status: 'nonRetryable',
      reason: 'unexpected response shape',
      cause: { nope: true },
    });
  });

  it('returns retryable when the DO emits the exact "Session owner not found" literal', () => {
    const cause = new CommandDeliveredError(SESSION_OWNER_NOT_FOUND_LITERAL);
    const result = classifyCreateSessionResult({ status: 'rejected', reason: cause });
    expect(result).toEqual({
      status: 'retryable',
      reason: SESSION_OWNER_NOT_FOUND_LITERAL,
      cause,
    });
  });

  it('returns nonRetryable for a delivered CLI string failure with a non-matching message', () => {
    const cause = new CommandDeliveredError('failed to create session');
    const result = classifyCreateSessionResult({ status: 'rejected', reason: cause });
    expect(result).toEqual({
      status: 'nonRetryable',
      reason: 'failed to create session',
      cause,
    });
  });

  it('returns nonRetryable for a structured UserWebCommandError with CLI_UPGRADE_REQUIRED', () => {
    const cause = new UserWebCommandError({
      code: 'CLI_UPGRADE_REQUIRED',
      message: 'Creating remote sessions from mobile requires a newer Kilo CLI.',
    });
    const result = classifyCreateSessionResult({ status: 'rejected', reason: cause });
    expect(result.status).toBe('nonRetryable');
    if (result.status === 'nonRetryable') {
      expect(result.reason).toBe('Creating remote sessions from mobile requires a newer Kilo CLI.');
      expect(result.cause).toBe(cause);
    }
  });

  it('returns nonRetryable for any other structured UserWebCommandError code', () => {
    const cause = new UserWebCommandError({
      code: 'SESSION_OWNER_CHANGED',
      message: 'Session owner changed',
    });
    const result = classifyCreateSessionResult({ status: 'rejected', reason: cause });
    expect(result.status).toBe('nonRetryable');
  });

  it('returns retryable for a non-delivered transport failure (plain Error)', () => {
    const cause = new Error('Connection destroyed');
    const result = classifyCreateSessionResult({ status: 'rejected', reason: cause });
    expect(result).toEqual({
      status: 'retryable',
      reason: 'Connection destroyed',
      cause,
    });
  });

  it('returns retryable for a non-Error rejection (e.g. thrown string)', () => {
    const result = classifyCreateSessionResult({ status: 'rejected', reason: 'weird' });
    expect(result).toEqual({
      status: 'retryable',
      reason: 'transport failure',
      cause: 'weird',
    });
  });
});

describe('createSessionSpawner', () => {
  it('exposes a stable creationKey and a spawn function', () => {
    const spawner: CreateSessionSpawner = createSessionSpawner(
      // eslint-disable-next-line typescript-eslint/require-await -- no await needed; return value is the whole point
      makeConnection(async () => undefined)
    );
    expect(typeof spawner.creationKey).toBe('string');
    expect(spawner.creationKey.length).toBeGreaterThan(0);
    expect(typeof spawner.spawn).toBe('function');
  });

  it('generates a fresh creationKey per spawner instance', () => {
    // eslint-disable-next-line typescript-eslint/require-await -- no await needed; return value is the whole point
    const a = createSessionSpawner(makeConnection(async () => undefined));
    // eslint-disable-next-line typescript-eslint/require-await -- no await needed; return value is the whole point
    const b = createSessionSpawner(makeConnection(async () => undefined));
    expect(a.creationKey).not.toBe(b.creationKey);
  });

  it('spawn returns ready when the SDK resolves a valid envelope', async () => {
    const spawner = createSessionSpawner(
      // eslint-disable-next-line typescript-eslint/require-await -- no await needed; return value is the whole point
      makeConnection(async () => ({ protocolVersion: 1, sessionID: VALID_SESSION_ID }))
    );
    const outcome = await spawner.spawn('cli-owner-1');
    expect(outcome).toEqual({ status: 'ready', sessionID: VALID_SESSION_ID });
  });

  it('spawn wraps delivered bare-string errors via the classifier', async () => {
    const spawner = createSessionSpawner(
      // eslint-disable-next-line typescript-eslint/require-await -- no await needed; throw is the whole point
      makeConnection(async () => {
        throw new CommandDeliveredError('failed to create session');
      })
    );
    const outcome = await spawner.spawn('cli-owner-1');
    expect(outcome.status).toBe('nonRetryable');
  });

  it('spawn returns retryable for a transport failure', async () => {
    const spawner = createSessionSpawner(
      // eslint-disable-next-line typescript-eslint/require-await -- no await needed; throw is the whole point
      makeConnection(async () => {
        throw new Error('Connection destroyed');
      })
    );
    const outcome = await spawner.spawn('cli-owner-1');
    expect(outcome.status).toBe('retryable');
  });
});
