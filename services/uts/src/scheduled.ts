import { errorFields, runMaintenance, step } from './audit/maintenance';
import { AUDIT_SHARD_COUNT } from './audit/relay';
import { withIdentityStore } from './db/client';
import { getAuditRelayStub, getLoginRotationStub } from './dos/stubs';
import { readConfig, type Env, type UtsConfig } from './env';
import { identityStoreBinding } from './grants/binding';
import { retainNotices, sweepNotices } from './notices/dispatch';
import { type NoticesAccess, noticesAccess } from './notices/store';
import { readUtsSecrets } from './secrets';
import { noticeEmailTransport, platformFetch } from './signin/email/delivery';
import { type MailSettings, logMisconfigured, signInConfigFor } from './signin/providers/config';

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
 * The cron's notice step. Mail `off`: the sweep settles email as `not_configured`. Mail `on`: it
 * sends through Mailgun. Mail `misconfigured` (a deploy error) or `unavailable` (no usable STS
 * bundle): the step claims nothing and only runs retention, because a round now would settle every
 * due notice's email as `not_configured` for good; the notices stay pending and go out once the
 * settings are fixed or the bundle is back, within their 24 hours. Push has no deployed provider
 * yet, so it waits with them and then settles as `not_configured`.
 */
export async function noticeStep(
  mail: MailSettings,
  notices: NoticesAccess,
  fetcher: typeof fetch
): Promise<void> {
  if (mail.status === 'misconfigured' || mail.status === 'unavailable') {
    if (mail.status === 'misconfigured') logMisconfigured('notice_email', mail.missing);
    await retainNotices(notices);
    return;
  }
  await sweepNotices({
    notices,
    transports: { push: null, email: noticeEmailTransport(mail, fetcher) },
    now: () => new Date(),
  });
}

/**
 * The cron's login rotation step (design 5.2): one call to the rotation object, which runs at most
 * one cycle's next transitions and returns. The object itself refuses a second run in parallel.
 * Nothing is called while `LOGIN_ROTATION` is not `on`.
 */
export async function loginRotationStep(env: Env, config: UtsConfig): Promise<void> {
  if (config.loginRotation.status === 'off') return;
  const result = await getLoginRotationStub(env, config).run();
  const fields = { event: 'uts.login_rotation.run', ...result };
  if (result.status === 'misconfigured') console.error(JSON.stringify(fields));
  else console.log(JSON.stringify(fields));
}

/**
 * The minute cron: keeps the 8 shard relays running; on one connection ends long transactions,
 * maintains audit partitions, OAuth rows and sign-in rows, and raises the relay-lag alert
 * (`src/audit/maintenance.ts`); then runs the notice step (`noticeStep`), whose claim and finish
 * statements open their own connections (`src/notices/dispatch.ts`), and the login rotation step
 * (`loginRotationStep`), which is off unless the environment turns it on. Nothing runs until the
 * environment binds its identity store. Every statement is its own transaction, and each step logs
 * its own failure.
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
  await step('notices', async () =>
    noticeStep(
      signInConfigFor(env, await readUtsSecrets(env, config, context), config).mail,
      noticesAccess(binding.connectionString, context),
      platformFetch
    )
  );
  await step('login_rotation', () => loginRotationStep(env, config));
}
