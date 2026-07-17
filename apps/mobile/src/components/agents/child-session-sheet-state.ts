import { type ChildSessionHydrationState } from 'cloud-agent-sdk';

type ChildSessionSheetState = 'loading' | 'empty' | 'error' | 'content';

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
