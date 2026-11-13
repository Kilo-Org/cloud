import { type ForwardInfo, type SessionInfo } from './ReactNativeSsh.types';
import ReactNativeSsh from './ReactNativeSshModule';
import { guard } from './errors';

/**
 * What the native registry still holds.
 *
 * The native side owns every socket for as long as the process lives, so these
 * two reads are how a runtime that just started — a reload, or a fresh launch
 * against a kept-alive process — finds the sessions and listeners it did not
 * open. A build without the module rejects, and the caller treats that as
 * "nothing survived".
 */
export function listSessions(): Promise<SessionInfo[]> {
  return guard(() => Promise.resolve(ReactNativeSsh.listSessions()));
}

export function listForwards(): Promise<ForwardInfo[]> {
  return guard(() => Promise.resolve(ReactNativeSsh.listForwards()));
}

/** Stops a listener by the id the registry gave it, without a wrapper object. */
export function stopForwardById(forwardId: string): Promise<void> {
  return guard(() => ReactNativeSsh.stopForward(forwardId));
}

export type { ForwardInfo, SessionInfo };
