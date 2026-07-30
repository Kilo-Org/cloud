import { type ChildSessionHydrationState, type KiloSessionId } from '@kilocode/cloud-agent-sdk';

type ChildSessionSheetState = 'loading' | 'empty' | 'error' | 'content';

export type ChildSessionSheetIdentity = {
  sessionId: KiloSessionId;
  title: string;
};

/**
 * Controls when the native Modal is mounted and when it is visible. Keeping
 * the sheet mounted after close lets `visible` transition from true → false
 * so the native pageSheet dismissal animation runs.
 */
export type ChildSessionSheetMountState = {
  sheet: ChildSessionSheetIdentity | null;
  visible: boolean;
};

export function getChildSessionSheetState(
  hydrationState: ChildSessionHydrationState,
  messageCount: number
): ChildSessionSheetState {
  if (messageCount > 0) {
    return 'content';
  }
  if (hydrationState.status === 'ready') {
    return 'empty';
  }
  if (hydrationState.status === 'error') {
    return 'error';
  }
  return 'loading';
}

export function openChildSessionSheet(
  _current: ChildSessionSheetMountState,
  next: ChildSessionSheetIdentity
): ChildSessionSheetMountState {
  return { sheet: next, visible: true };
}

export function closeChildSessionSheet(
  current: ChildSessionSheetMountState
): ChildSessionSheetMountState {
  return { sheet: current.sheet, visible: false };
}
