import type { ChatSyncSetting } from './sync-settings';

/**
 * The setting as the app knows it: still being read, unreadable (with
 * whether asking again can help), on, or off. `enabled` derives from this one
 * union, so a half-read setting never reads as "off" and quietly drops sync.
 */
export type ChatSyncSettingState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly retryable: boolean; readonly retry: () => void }
  | { readonly kind: 'on' }
  | { readonly kind: 'off' };

export type ChatSyncGate = {
  readonly state: ChatSyncSettingState;
  /** Sync runs unless this device was told to keep chats local. */
  readonly enabled: boolean;
  readonly decide: (choice: ChatSyncSetting) => Promise<void>;
};

/** The union one settings read answers with. Pure, so every state is testable. */
export function selectChatSyncSettingState(input: {
  readonly hasPlace: boolean;
  readonly isPending: boolean;
  readonly isPaused: boolean;
  readonly isError: boolean;
  readonly setting: ChatSyncSetting | undefined;
  readonly retry: () => void;
}): ChatSyncSettingState {
  if (!input.hasPlace) {
    return { kind: 'failed', retryable: false, retry: input.retry };
  }
  if (input.setting !== undefined) {
    return input.setting === 'on' ? { kind: 'on' } : { kind: 'off' };
  }
  if (input.isError) {
    return { kind: 'failed', retryable: input.isPaused, retry: input.retry };
  }
  return { kind: 'loading' };
}