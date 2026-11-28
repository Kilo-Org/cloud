/**
 * Runs the two scheduled jobs in the order the counter promise depends on: the summary always runs,
 * and an alerting failure still fails the cron run afterwards (its `AggregateError` is the only
 * report of a broken evaluation path). Kept here, away from the Worker entrypoint, so it is
 * testable without `cloudflare:workers`.
 */
export async function runScheduledJobs(
  evaluateAlerts: () => Promise<void>,
  summarize: () => Promise<void>
): Promise<void> {
  let alertingFailure: unknown;
  try {
    await evaluateAlerts();
  } catch (error) {
    alertingFailure = error;
  }
  await summarize();
  if (alertingFailure !== undefined) throw alertingFailure;
}
