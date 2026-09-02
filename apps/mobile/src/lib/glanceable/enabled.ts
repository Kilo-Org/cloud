import * as SecureStore from 'expo-secure-store';

import { GLANCEABLE_ENABLED_KEY } from '@/lib/storage-keys';

/**
 * Master switch for the Active Agents glanceable surfaces, kept free of the
 * preference store's toast and Sentry imports so the publisher, the background
 * push, and the ActivityKit prompt can read it without loading that graph.
 *
 * Default-on: only the exact stored string 'false' turns the surfaces off, so a
 * missing or unreadable value keeps the behavior the app ships with. The OS
 * gates (iOS Live Activities, Android notification permission) stay in force
 * above this switch.
 */
export function parseGlanceableEnabled(raw: string | null): boolean {
  return raw !== 'false';
}

export function serializeGlanceableEnabled(value: boolean): string {
  return value ? 'true' : 'false';
}

/**
 * Disk read for callers with no React state, including the headless background
 * push whose process starts with the in-memory default.
 */
export async function readGlanceableEnabled(): Promise<boolean> {
  try {
    return parseGlanceableEnabled(await SecureStore.getItemAsync(GLANCEABLE_ENABLED_KEY));
  } catch {
    return true;
  }
}
