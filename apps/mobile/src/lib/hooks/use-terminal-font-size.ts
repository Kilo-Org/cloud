import { useSyncExternalStore } from 'react';

import { createSecureStorePreference } from '@/lib/hooks/secure-store-preference';
import { SSH_TERMINAL_FONT_SIZE_KEY } from '@/lib/storage-keys';

const MIN_TERMINAL_FONT_SIZE = 9;
const MAX_TERMINAL_FONT_SIZE = 28;
const DEFAULT_TERMINAL_FONT_SIZE = 13;

/** A stored size, clamped to what the terminal can lay out. */
function parseTerminalFontSize(raw: string | null): number {
  const value = Number(raw);
  if (raw === null || !Number.isFinite(value)) {
    return DEFAULT_TERMINAL_FONT_SIZE;
  }
  return Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(value)));
}

const store = createSecureStorePreference<number>({
  key: SSH_TERMINAL_FONT_SIZE_KEY,
  defaultValue: DEFAULT_TERMINAL_FONT_SIZE,
  parse: parseTerminalFontSize,
  serialize: value => String(parseTerminalFontSize(String(value))),
});

/**
 * The terminal's point size. A pinch in the terminal reports it through
 * `onFontSizeChange`; every session renders at the stored size, so the choice
 * survives a reconnect and the next launch.
 */
export function useTerminalFontSize() {
  const fontSize = useSyncExternalStore(store.subscribe, store.get);
  return { fontSize, setFontSize: store.set };
}
