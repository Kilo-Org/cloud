/**
 * The app's foreground signal, as one subscription, for the attachment upload's
 * inactivity window.
 *
 * This module holds no native import on purpose. `uploadTask` needs the signal
 * but must stay loadable in the node test project, and the hooks module that
 * owns the app's `AppState` store is imported by screens whose mounted tests do
 * not provide the native modules `expo-file-system` loads. Keeping the registry
 * here lets the app register the real source while neither side imports the
 * other's dependencies.
 */
export type ForegroundSource = {
  addEventListener(type: 'change', handler: (state: string) => void): { remove(): void };
};

let source: ForegroundSource | undefined = undefined;

/** Registers the app's `AppState`-shaped source. The app root calls this once. */
export function setUploadForegroundSource(next: ForegroundSource): void {
  source = next;
}

/**
 * The registered source, or `undefined` when nothing registered one. Without it
 * the window measures wall-clock inactivity, which is right on Android and for a
 * foreground iOS transfer.
 */
export function uploadForegroundSource(): ForegroundSource | undefined {
  return source;
}
