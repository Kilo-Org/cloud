/**
 * DoltHub current-user API — `GET /user`.
 *
 * Resolves the account that owns an API token. The join ceremony uses
 * it to check that an org it is about to trust is the token's own
 * account, because the org can otherwise only be asserted by the
 * caller.
 */

import { z } from 'zod';
import {
  buildDoltUrl,
  doltFetch,
  WlDoltHubError,
  type DoltFetchHooks,
  type DoltHubAuth,
} from './api';

const CurrentUserResponse = z
  .object({
    status: z.string().optional(),
    username: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();

export type GetAuthenticatedUserOptions = {
  auth: DoltHubAuth;
  fetch?: typeof fetch;
  hooks?: DoltFetchHooks;
};

/**
 * Return the DoltHub username that owns the token. Throws
 * `WlDoltHubError` when the token cannot be resolved, so a caller that
 * needs the identity never proceeds on a guess.
 */
export async function getAuthenticatedUsername(opts: GetAuthenticatedUserOptions): Promise<string> {
  const res = await doltFetch({
    method: 'GET',
    path: '/user',
    auth: opts.auth,
    fetch: opts.fetch,
    hooks: opts.hooks,
  });
  const url = buildDoltUrl('/user');
  const parsed = CurrentUserResponse.safeParse(res.json ?? {});
  const username = parsed.success ? (parsed.data.username ?? '').trim() : '';

  if (res.status < 200 || res.status >= 300 || username.length === 0) {
    throw new WlDoltHubError(
      `Could not resolve the DoltHub account for this token (${res.status})`,
      res.status,
      res.json ?? res.text,
      url
    );
  }
  return username;
}
