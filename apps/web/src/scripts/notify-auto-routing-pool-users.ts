import { discoverPoolNotificationOwners } from './lib/auto-routing-pool-notification-discovery';
import {
  PoolNotificationError,
  parsePoolNotificationOptions,
  runPoolNotifications,
} from './lib/auto-routing-pool-notifications';
import type { PoolNotificationResult } from './lib/auto-routing-pool-notifications';

function report(result: PoolNotificationResult, cutoverAt: string) {
  console.log(JSON.stringify({ ...result, cutoverAt }));
  if (result.ambiguous > 0 || result.failed > 0 || result.followupRequired > 0)
    process.exitCode = 1;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log(`Usage: pnpm script src/scripts/notify-auto-routing-pool-users.ts --cutover-at <ISO timestamp with Z or UTC offset> --state-dir <private directory> [--send | --refresh-plan | --reconcile-target <hash> --reconcile-outcome <sent|not_sent>]

Run only after the full migration scan is clean and migrated model IDs have been verified.
The default is a dry run: it discovers live contacts and saves hashed targets, without sending.
Inspect counts and targetStatuses, then rerun with the same arguments plus --send to deliver.
Reuse the same private state directory for every retry. Sent targets are never implicitly resent.
Missing or invalid billing contacts fail the entire live preflight; affected owners are not skipped.
Ordinary dry runs and --send reject live recipients/router metadata that differ from the saved plan.

--refresh-plan is an explicit dry run that reviews and saves the current live plan:
new recipients become pending, removed recipients become inactive and are not sent, and all
delivery history remains. Already-sent recipients stay sent even if router metadata changes.
Their requiresFollowup status means a separate, explicitly reviewed followup is needed; --send
will not resend them. Inspect this dry-run output before rerunning without --refresh-plan to send.

An attempted status means the provider outcome is UNKNOWN, not a failure or success.
Other pending targets still send; unknown attempts are never retried automatically.
After checking provider records, record exactly one confirmed outcome without sending:
  --reconcile-target <targetHash> --reconcile-outcome sent
  --reconcile-target <targetHash> --reconcile-outcome not_sent
Only attempted targets may be reconciled. sent is skipped forever in this campaign; not_sent
permits a later explicit --send retry, subject to live-plan checks. Transport errors alone prove
neither outcome. If records are inconclusive, leave the attempt unknown.
targetStatuses prints only private campaign-specific hashes, statuses and review flags.
Match a provider recipient locally using HMAC-SHA256 with state.json's hashKey and the trimmed,
lowercase email as input. Never put raw recipients into logs or reconciliation flags.
Reconciliation needs no database/mail configuration and can use the saved timestamp after it passes.
Unresolved attempts, active not_sent targets, or required followups produce a nonzero exit status.

The saved cutover timestamp is immutable, including during refresh and reconciliation.
If the date changes, retain the original directory and reconcile every unknown provider outcome.
Then create a NEW private state directory for a deliberate date-change/followup notification:
dry-run the new timestamp, review its live plan, then explicitly --send. This is a new campaign
and will notify previously sent recipients again; it is NEVER a way to retry the old campaign.
Plan/send/refresh require a future timestamp; reconcile always requires the original timestamp.
Never discard history or remove a lock without confirming the previous sender stopped.
No raw recipient lists are printed or exported. --send requires configured production email delivery.`);
    return;
  }
  const options = parsePoolNotificationOptions(args);
  if (process.env.DEBUG_QUERY_LOGGING) {
    throw new PoolNotificationError('Disable DEBUG_QUERY_LOGGING to avoid logging recipient data.');
  }
  if (options.reconcile) {
    report(await runPoolNotifications(options), options.cutoverAt);
    return;
  }
  // Credential-dependent modules are deferred so --help needs no database or mail configuration.
  const { db, pool } = await import('@kilocode/web-shared/lib/drizzle');
  try {
    const owners = await discoverPoolNotificationOwners(db);
    if (options.send) {
      // A dry run must not load mail configuration or require unrelated server secrets.
      const { MAILGUN_API_KEY, MAILGUN_DOMAIN } =
        await import('@kilocode/web-shared/lib/config.server');
      if (
        process.env.VERCEL_TARGET_ENV !== 'production' ||
        process.env.NODE_ENV === 'test' ||
        process.env.IS_IN_AUTOMATED_TEST ||
        !MAILGUN_API_KEY ||
        !MAILGUN_DOMAIN
      ) {
        throw new PoolNotificationError(
          '--send requires configured production email delivery; suppressed or redirected delivery cannot be marked sent.'
        );
      }
    }
    const result = await runPoolNotifications({
      ...options,
      owners,
      sendEmail: async (target, cutoverAt) => {
        // Keep the credential-dependent mail module outside the dry-run path.
        const { sendAutoRoutingPoolNoticeEmail } =
          await import('@kilocode/web-shared/lib/auto-routing-pool-notice-email');
        return sendAutoRoutingPoolNoticeEmail({ ...target, cutoverAt });
      },
    });
    report(result, options.cutoverAt);
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error(
    error instanceof PoolNotificationError
      ? error.message
      : 'Pool notification failed. No raw error details are logged; retain the state directory and reconcile before retrying.'
  );
  process.exitCode = 1;
});
