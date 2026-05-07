/* eslint-disable no-console */

function isReactNativeDev(): boolean {
  return (globalThis as { __DEV__?: boolean }).__DEV__ === true;
}

export function debugKiloChat(message: string, data?: Record<string, unknown>): void {
  if (!isReactNativeDev()) {
    return;
  }
  if (data) {
    console.log(`[kilo-chat] ${message}`, data);
    return;
  }
  console.log(`[kilo-chat] ${message}`);
}
