import type { SshHost } from '../hosts';

/**
 * The password an attempt sends for `host`: one typed for this host in the open
 * session wins over the one saved with it, so a saved password the server
 * refuses can always be corrected from the prompt.
 */
export function passwordFor(
  host: Pick<SshHost, 'id' | 'password'>,
  prompted: ReadonlyMap<string, string>
): string | null {
  return prompted.get(host.id) ?? host.password ?? null;
}
