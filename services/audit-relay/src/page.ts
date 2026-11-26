import type { SecretsExecutionContext } from '@kilocode/secrets-client';
import { errorName } from './relay/error-name';
import { pageSlack } from './relay/slack';
import { secretsFor, type SecretsEnv } from './secrets';

/**
 * Pages the on-call channel. The text carries stream names, sequences, keys and reasons only,
 * never an event payload or a secret. A paging failure is logged, never thrown: the caller's
 * own outcome (ack, retry, a failed pass) must not depend on Slack.
 */
export async function pageOperator(
  env: SecretsEnv,
  message: string,
  ctx?: SecretsExecutionContext
): Promise<void> {
  try {
    const webhook = await secretsFor(env).get('AUDIT_RELAY_SLACK_WEBHOOK_PAGE', ctx);
    if (!(await pageSlack(webhook, message, fetch))) {
      console.error(JSON.stringify({ event: 'audit_relay.page_undelivered' }));
    }
  } catch (error) {
    console.error(JSON.stringify({ event: 'audit_relay.page_failed', error: errorName(error) }));
  }
}
