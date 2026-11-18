/**
 * The single e2e-scoped `INTERNAL_API_SECRET`, shared by the local dev launcher,
 * the provisioning entry points and the e2e driver.
 *
 * Deliberately has no Worker import: the surface middleware inlines
 * `timingSafeEqual`, so no reverse import exists and this module stays usable
 * from plain Node.
 *
 * Provisioning is ACTIVE, not inert. `src/router/auth.ts`, `src/server.ts` and
 * `src/e2e-entry.ts` already read the binding, so once the value reaches the
 * `cloud-agent-e2e-test` Worker its holder can call
 * `/trpc/prepareSession|updateSession|cleanupSession|getWrapperLogs` and
 * `/internal/sandbox-control/seed` directly. The value must therefore be scoped
 * to that Worker and must differ from production's `INTERNAL_API_SECRET` — an
 * operator requirement no script can prove, because no script can read
 * production's value.
 *
 * `requireE2eInternalSecret` is the one owner of the shared acceptance rules
 * (non-empty, minimum length, no whitespace, not the development default). The
 * renderer, `deployed-auth.ts` and `deploy-e2e-worker.sh` all call it, so the
 * driver, the deploy script and the local render agree on those rules. The
 * renderer adds one local-only rule the deployed paths deliberately do not: the
 * `[A-Za-z0-9._~-]` dotenv alphabet, which guards the `.dev.vars` line rather
 * than the secret, and lives next to that write. `resolveE2eInternalSecret` is
 * the one place the local side chooses the value.
 */

/**
 * Insecure development default. It exists only so a zero-config local stack has
 * a value to hand the renderer, which refuses it: it is never protection.
 */
export const LOCAL_E2E_INTERNAL_API_SECRET = 'local-e2e-internal-secret';

/** The shortest accepted e2e internal secret, shared by every provisioning path. */
export const E2E_INTERNAL_SECRET_MIN_LENGTH = 16;

/** The environment shape the resolver reads. `process.env` fits. */
export type E2eInternalSecretEnv = Record<string, string | undefined>;

/**
 * The one place the local-facing e2e internal secret is chosen: the operator's
 * `E2E_INTERNAL_API_SECRET` when set, otherwise the insecure development
 * default, which every provisioning path rejects.
 */
export function resolveE2eInternalSecret(env: E2eInternalSecretEnv = process.env): string {
  return env.E2E_INTERNAL_API_SECRET ?? LOCAL_E2E_INTERNAL_API_SECRET;
}

/**
 * The one owner of the shared e2e internal secret rules. `source` names where
 * the value came from for the diagnostic; it is never the value itself.
 */
export function requireE2eInternalSecret(raw: unknown, source = 'E2E_INTERNAL_API_SECRET'): string {
  const value = String(raw ?? '');
  if (value.length === 0) {
    throw new Error(`${source} is required and must not be empty.`);
  }
  if (value === LOCAL_E2E_INTERNAL_API_SECRET) {
    throw new Error(
      `Refusing the insecure development default for ${source} (${LOCAL_E2E_INTERNAL_API_SECRET}).`
    );
  }
  if (value.length < E2E_INTERNAL_SECRET_MIN_LENGTH) {
    throw new Error(`${source} must be at least ${E2E_INTERNAL_SECRET_MIN_LENGTH} characters.`);
  }
  if (/\s/.test(value)) {
    throw new Error(`${source} must not contain whitespace.`);
  }
  return value;
}
