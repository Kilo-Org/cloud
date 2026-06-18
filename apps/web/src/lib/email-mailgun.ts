import Mailgun from 'mailgun.js';
import FormData from 'form-data';
import { MAILGUN_API_KEY, MAILGUN_DOMAIN } from '@/lib/config.server';
import {
  routeOutboundEmail,
  type OutboundEmailParams,
  type OutboundEmailRoute,
} from '@/lib/email-delivery-policy';
import { writeEmailToLocalOutbox } from '@/lib/email-local-outbox';
import { captureMessage } from '@sentry/nextjs';

const mailgun = new Mailgun(FormData);

type EmailRoutingLog = {
  mode: 'redirect' | 'local_outbox' | 'suppressed' | 'configuration_error';
  targetEnvironment: string | null;
  category: string;
  outcome: 'delivered' | 'captured' | 'suppressed' | 'failed';
  outboxFile?: string;
};

function logEmailRouting(route: EmailRoutingLog): void {
  console.info('[email_service] Routed outbound email', route);
}

async function handleNonMailgunRoute(
  route: Exclude<OutboundEmailRoute, { kind: 'mailgun' }>,
  category: string
): Promise<boolean> {
  if (route.kind === 'local_outbox') {
    const outboxFile = await writeEmailToLocalOutbox(route.params);
    logEmailRouting({
      mode: 'local_outbox',
      targetEnvironment: null,
      category,
      outcome: 'captured',
      outboxFile,
    });
    return true;
  }
  if (route.kind === 'configuration_error') {
    const message = 'VERCEL_TARGET_ENV is required for production email delivery';
    logEmailRouting({
      mode: 'configuration_error',
      targetEnvironment: null,
      category,
      outcome: 'failed',
    });
    captureMessage(message, { level: 'error', tags: { source: 'email_service' } });
    return false;
  }

  logEmailRouting({
    mode: 'suppressed',
    targetEnvironment: route.targetEnvironment,
    category,
    outcome: 'suppressed',
  });
  return true;
}

export async function sendViaMailgun(params: OutboundEmailParams): Promise<boolean> {
  const route = routeOutboundEmail(params);
  const category = params.category ?? 'uncategorized';
  if (route.kind !== 'mailgun') return handleNonMailgunRoute(route, category);

  if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN) {
    const message = 'MAILGUN_API_KEY/MAILGUN_DOMAIN not set — cannot send email via Mailgun';
    console.warn(message);
    captureMessage(message, { level: 'warning', tags: { source: 'email_service' } });
    return false;
  }

  const client = mailgun.client({ username: 'api', key: MAILGUN_API_KEY });
  await client.messages.create(MAILGUN_DOMAIN, {
    from: 'Kilo Code <hi@app.kilocode.ai>',
    'h:Reply-To': route.params.replyTo ?? 'hi@kilocode.ai',
    to: route.params.to,
    subject: route.params.subject,
    html: route.params.html,
  });

  if (route.mode === 'redirect') {
    logEmailRouting({
      mode: 'redirect',
      targetEnvironment: 'staging',
      category,
      outcome: 'delivered',
    });
  }
  return true;
}
