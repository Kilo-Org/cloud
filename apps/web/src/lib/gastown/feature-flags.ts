import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';

/**
 * Gastown is killed, for everyone, admins included, only when GASTOWN_KILLED
 * is exactly `true`. Read per call so no restart of module state is needed.
 */
export function isGastownKilled(): boolean {
  return getEnvVariable('GASTOWN_KILLED') === 'true';
}

export async function isGastownEnabled(
  _userId: string,
  _opts?: { isAdmin?: boolean }
): Promise<boolean> {
  return !isGastownKilled();
}
