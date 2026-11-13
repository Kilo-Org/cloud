import type * as SshPackage from '@kilocode/react-native-ssh';

/**
 * The SSH package, loaded once on first use.
 *
 * The import is dynamic on purpose: the package's entry point calls
 * `requireNativeModule` at module load, which throws in a build without the
 * native module. A static import would crash every consumer of the session
 * code — the app layout, and every unit test that renders a screen next to it —
 * instead of failing only a connection attempt, which is what a build without
 * the module should do.
 */
let loading: Promise<typeof SshPackage> | null = null;

export function sshPackage(): Promise<typeof SshPackage> {
  loading ??= import('@kilocode/react-native-ssh');
  return loading;
}
