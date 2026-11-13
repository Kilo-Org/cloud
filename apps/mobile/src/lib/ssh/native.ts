import type * as SshPackage from '../../../modules/kilo-ssh/src';
import { z } from 'zod';

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
  loading ??= import('../../../modules/kilo-ssh/src');
  return loading;
}

/** A rejected native call carries its `SshErrorCode` as `code`. */
const rejectedCallSchema = z.object({ code: z.string() });

/** The code a rejected native call carries, or `null` when it carries none. */
export function nativeErrorCode(cause: unknown): string | null {
  const parsed = rejectedCallSchema.safeParse(cause);
  return parsed.success ? parsed.data.code : null;
}
