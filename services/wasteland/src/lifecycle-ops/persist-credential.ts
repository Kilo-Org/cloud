/**
 * Writes the credential a wasteland join leaves behind.
 *
 * Kept apart from `lifecycle-ops.ts` for the same reason as
 * `lifecycle-ops-inner.ts`: the wrapper resolves the worker `Env` and
 * the WastelandDO, while this module only needs the credential store,
 * so the Node test pool can run it against a real SQLite database.
 */

import type { WastelandCredentialResult } from '../dos/wasteland/credentials';
import { bindCredentialToken } from '../util/credential-binding.util';

export type JoinCredentialContext = {
  doStub: {
    getCredential(userId: string): Promise<WastelandCredentialResult | null>;
    storeCredential(input: {
      userId: string;
      encryptedToken: string;
      dolthubOrg: string;
      rigHandle?: string;
      provenOrg?: string;
      isUpstreamAdmin?: boolean;
    }): Promise<WastelandCredentialResult>;
  };
  /** Upstream `owner/db` — only used to label the log line. */
  upstream: string;
  /** The org this join resolved for {@link token}: the fresh OAuth
   *  account, or the org the stored token was decrypted for. */
  forkOrg: string;
  /** The token that drove the join. */
  token: string;
};

/**
 * Persist the verified `rig_handle` together with a token/org pair that
 * agree with each other.
 *
 * The org written is the one this join resolved for its token, so a join
 * on a fresh OAuth token records that token under the org it joined as
 * and a join on the stored token keeps the row's org. Either way the
 * stored ciphertext is kept only while the row already names that org.
 */
export async function persistJoinCredential(
  env: Pick<Env, 'WASTELAND_ENCRYPTION_KEY'>,
  ctx: JoinCredentialContext,
  userId: string,
  rigHandle: string
): Promise<void> {
  const existing = await ctx.doStub.getCredential(userId);

  const binding = await bindCredentialToken(env, {
    existing,
    org: ctx.forkOrg,
    token: ctx.token,
  });
  if (binding.status === 'key-unavailable') {
    // Without an encryption key we can't persist. Surface as a soft
    // warning rather than failing the whole join — the user already has
    // the PR, and the fallback path will prompt them to reconnect later.
    // The stored row is left as it was, which keeps it internally
    // consistent.
    console.warn(
      '[lifecycle-ops:persistCredential] encryption key unavailable; skipping credential save',
      { wastelandId: ctx.upstream, userId }
    );
    return;
  }

  await ctx.doStub.storeCredential({
    userId,
    encryptedToken: binding.encryptedToken,
    dolthubOrg: binding.dolthubOrg,
    rigHandle,
    // A successful join established this org with DoltHub: the fork was
    // created under it, the registration write landed in its fork, or
    // the credential already carried that proof. Record it so later
    // joins can reuse it, and so nothing trusts a handle alone.
    provenOrg: ctx.forkOrg,
    isUpstreamAdmin: existing?.is_upstream_admin ?? false,
  });
}
