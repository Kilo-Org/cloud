import { errorFields, runMaintenance, step } from './audit/maintenance';
import { AUDIT_SHARD_COUNT } from './audit/relay';
import { withIdentityStore } from './db/client';
import { getAuditRelayStub } from './dos/stubs';
import { readConfig, type Env, type UtsConfig } from './env';
import { identityStoreBinding } from './grants/binding';
import { sweepNotices } from './notices/dispatch';
import { noticesAccess } from './notices/store';
import { noticeEmail, platformFetch } from './signin/email/delivery';
import { logMisconfigured, signInConfigFor } from './signin/providers/config';

/** Arms each shard's relay object; logs `uts.audit_relay.not_started` for one that failed or refused. */
export async function startRelays(env: Env, config: UtsConfig): Promise<void> {
  const shards = Array.from({ length: AUDIT_SHARD_COUNT }, (_, shard) => shard);
  const results = await Promise.allSettled(
    shards.map(shard => getAuditRelayStub(env, config, shard).ensureStarted())
  );
  results.forEach((result, shard) => {
    if (result.status === 'rejected' || !result.value) {
      console.error(
        JSON.stringify({
          event: 'uts.audit_relay.not_started',
          shard,
          ...(result.status === 'rejected' ? errorFields(result.reason) : { error: 'refused' }),
        })
      );
    }
  });
}

/**
 * The minute cron: keeps the 8 shard relays running; on one connection ends long transactions,
 * maintains audit partitions, OAuth rows and sign-in rows, and raises the relay-lag alert
 * (`src/audit/maintenance.ts`); then runs one notice sweep, whose claim and finish statements
 * open their own connections (`src/notices/dispatch.ts`). Nothing runs until the environment binds
 * its identity store. Every statement is its own transaction, and each step logs its own failure.
 * Email goes through Mailgun where the mail settings are on (src/signin/email/delivery.ts); push
 * has no deployed provider yet, so the sweep settles it as `not_configured`.
 */
export async function scheduled(
  _controller: ScheduledController,
  env: Env,
  context: ExecutionContext
): Promise<void> {
  const config = readConfig(env);
  const binding = identityStoreBinding(env);
  if (binding.kind === 'unprovisioned') return;
  await startRelays(env, config);
  await step('connect', () =>
    withIdentityStore(binding.connectionString, context, store => runMaintenance(store))
  );
  await step('notices', async () => {
    const mail = signInConfigFor(env, config).mail;
    if (mail.status === 'misconfigured') logMisconfigured('notice_email', mail.missing);
    await sweepNotices({
      notices: noticesAccess(binding.connectionString, context),
      transports: { push: null, email: noticeEmail(mail, platformFetch) },
      now: () => new Date(),
    });
  });
}
