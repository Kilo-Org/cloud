import type { BundleBinding } from '@kilocode/secrets-client';
import type { AttestBinding } from './attest';
import type { MigrationRunDO } from './dos/MigrationRunDO';
import type * as MainModule from './index';

/** The bindings and vars of `wrangler.jsonc`. The vars are read only through `readConfig`. */
export type Env = {
  /** STS's `SecretsBroker`, bound with `props: { caller: 'migration-proxy' }`. */
  STS: BundleBinding & AttestBinding;
  MIGRATION_RUN_DO: DurableObjectNamespace<MigrationRunDO>;
  AUDIT_QUEUE: Queue;
  MIGRATION_PROXY_ENVIRONMENT?: string;
  MIGRATION_DB_TARGET?: string;
  MIGRATION_DB_USER?: string;
  MIGRATION_DB_LOGIN_MODE?: string;
  MIGRATION_SESSION_KEY?: string;
  MIGRATION_SESSION_SAMPLE_MINUTES?: string;
  MIGRATION_RUN_DEADLINE_SECONDS?: string;
  MIGRATION_PROXY_GITHUB_APP_ID?: string;
  MIGRATION_PROXY_GITHUB_INSTALLATION_ID?: string;
  MIGRATION_REVIEW_BASELINE_SHA?: string;
};

declare global {
  // A global augmentation can only be written as a namespace.
  // oxlint-disable-next-line typescript/no-namespace
  namespace Cloudflare {
    /** Types `ctx.exports`: the object reaches the refusing outbound handler through it. */
    interface GlobalProps {
      mainModule: typeof MainModule;
      durableNamespaces: 'MigrationRunDO';
    }
  }
}
