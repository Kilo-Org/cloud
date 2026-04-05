import type { Env } from '../types';

/**
 * Get the DO stub for an app
 */
export function getAppDb(env: Env, appId: string) {
  const id = env.APP_DB.idFromName(appId);
  return env.APP_DB.get(id);
}
