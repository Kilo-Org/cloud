import { type SshHost } from '../hosts';
import { type LiveSession } from './live';

/** The connected app session each attempt test starts from. */
export function createLiveSession(host: SshHost): LiveSession {
  return {
    id: 'app',
    host,
    nativeSessionId: 'target',
    jumpSessionIds: ['outer', 'inner'],
    attempt: 10,
    reconnecting: false,
    timer: null,
    hostKey: null,
    prompts: null,
    passwords: new Map(),
    authHostId: null,
    passphrase: null,
    connecting: false,
    attemptAbort: null,
    connectAttemptId: null,
  };
}
