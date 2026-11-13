import { type SshHost } from '../hosts';
import { patchSession } from './session-store';
import {
  type SshHostKeyAwaiting,
  type SshPromptsAwaiting,
  type SshSessionPhase,
} from './types';

/**
 * What the manager holds for a session beyond what the screen renders: the
 * native ids, the inputs a sheet is waiting on, and the retry timer.
 */
export type LiveSession = {
  readonly id: string;
  host: SshHost;
  nativeSessionId: string | null;
  /** The attempt in flight or last finished; the next one is one higher. */
  attempt: number;
  timer: ReturnType<typeof setTimeout> | null;
  hostKey: SshHostKeyAwaiting | null;
  prompts: SshPromptsAwaiting | null;
  /** Typed once for this session when the host has no saved password. */
  password: string | null;
  /** Typed once for this session when the key needs one. */
  passphrase: string | null;
  /** The device-auth gate passed for this session's key. */
  keyUnlocked: boolean;
  connecting: boolean;
};

/** The sessions with a screen somewhere in the app, by the id that screen holds. */
export const live = new Map<string, LiveSession>();

/** Whether the session still has a screen: closing it forgets the entry. */
export function stillOpen(entry: LiveSession): boolean {
  return live.get(entry.id) === entry;
}

export function setPhase(entry: LiveSession, phase: SshSessionPhase): void {
  patchSession(entry.id, { phase });
}

export function clearTimer(entry: LiveSession): void {
  if (entry.timer !== null) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
}
