/**
 * One per-chat switch: the choice, and how far the chat's session is from it.
 *
 * The registry owns both flags on `ChatState`, so a tap, the write it makes and
 * the session move it causes are one operation of the chat. Nothing here draws
 * or stores anything: the phases and the four transitions are total functions,
 * which is what makes a late step unable to resurrect a phase a newer tap moved
 * past.
 */

/** The two per-chat flags the registry owns. Two, because two switches write them. */
export type ChatFlagName = 'webSearch' | 'kiloTools';

/**
 * Whether this chat's live session names the tools the saved choice names.
 * A session freezes its tool set, so a saved choice and a live session can
 * disagree; `behind` is that disagreement, and its recovery is `retryChatFlag`.
 */
export type ChatFlagApplication = 'current' | 'moving' | 'behind';

/** A choice that is on disk, and how far this chat is from it. */
export type ChatFlagSaved = {
  /** `true` on, `false` off, `null` never chosen (the switch draws its fallback). */
  readonly choice: boolean | null;
  readonly application: ChatFlagApplication;
};

/**
 * One chat flag, and no second boolean beside it:
 *
 * - `reading`: nothing has been read for this chat, so the switch draws its
 *   fallback and claims nothing about the stored choice.
 * - `unread`: the read failed; the fallback stays and a tap still writes.
 * - `saved`: `choice` is on disk and `application` says whether this session is on it.
 * - `picking`: the person tapped `next`; its persist is running, `was` is what a
 *   refusal falls back to.
 * - `refused`: the persist was refused, so `was` is back on screen and the tap
 *   was reported. Tapping again is the retry.
 */
export type ChatFlag =
  | { readonly kind: 'reading' }
  | { readonly kind: 'unread' }
  | ({ readonly kind: 'saved' } & ChatFlagSaved)
  | { readonly kind: 'picking'; readonly next: boolean; readonly was: ChatFlagSaved }
  | { readonly kind: 'refused'; readonly was: ChatFlagSaved };

/** What a switch goes back to when no choice has been read yet: its own fallback. */
const UNKNOWN: ChatFlagSaved = { choice: null, application: 'current' };

/** The saved part of a flag, which is what a tap and a refusal carry. */
function savedPartOf(flag: ChatFlag): ChatFlagSaved {
  switch (flag.kind) {
    case 'saved':
      return { choice: flag.choice, application: flag.application };
    case 'picking':
      return flag.was;
    case 'refused':
      return flag.was;
    case 'reading':
      return UNKNOWN;
    case 'unread':
      return UNKNOWN;
  }
}

/** The value the switch draws: the tap, else the saved choice, else the fallback. */
export function chatFlagValueOf(flag: ChatFlag, fallback: boolean): boolean {
  switch (flag.kind) {
    case 'reading':
      return fallback;
    case 'unread':
      return fallback;
    case 'saved':
      return flag.choice ?? fallback;
    case 'picking':
      return flag.next;
    case 'refused':
      // A refusal is told from a saved choice by the toast the tap reported: the
      // switch itself only goes back to what was on disk.
      return flag.was.choice ?? fallback;
  }
}

/**
 * Whether the row shows the not-applied state: a saved choice this chat's
 * session is not on. It is about the session, not the store, so the switch keeps
 * the saved value and only the status line and Retry change.
 */
export function chatFlagBehind(flag: ChatFlag): boolean {
  return flag.kind === 'saved' && flag.application === 'behind';
}

/**
 * The tap: the switch shows `next`; `was` is what a refusal puts back.
 *
 * A phase a tap already moved past is left as it is, so the tap of a switch that
 * is drawing a pending value cannot restart one.
 */
export function flagPicked(flag: ChatFlag, next: boolean): ChatFlag {
  if (flag.kind === 'picking') {
    return { kind: 'picking', next, was: flag.was };
  }
  return { kind: 'picking', next, was: savedPartOf(flag) };
}

/** The write landed: `saved` with the choice, and the move has not run yet. */
export function flagPersisted(flag: ChatFlag, choice: boolean): ChatFlag {
  if (flag.kind !== 'picking') {
    return flag;
  }
  return { kind: 'saved', choice, application: 'moving' };
}

/** The write was refused: back to the choice on disk. */
export function flagRefused(flag: ChatFlag): ChatFlag {
  if (flag.kind !== 'picking') {
    return flag;
  }
  return { kind: 'refused', was: flag.was };
}

/** How far this session is from the saved choice; only a `saved` flag carries one. */
export function flagApplication(flag: ChatFlag, application: ChatFlagApplication): ChatFlag {
  if (flag.kind !== 'saved') {
    return flag;
  }
  return { kind: 'saved', choice: flag.choice, application };
}
