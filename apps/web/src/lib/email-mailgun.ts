import Mailgun from 'mailgun.js';
import FormData from 'form-data';
import * as z from 'zod';
import { MAILGUN_API_KEY, MAILGUN_DOMAIN } from '@/lib/config.server';
import { writeEmailToLocalOutbox } from '@/lib/email-local-outbox';
import { captureMessage } from '@sentry/nextjs';

const mailgun = new Mailgun(FormData);

const stagingSinkSchema = z
  .email()
  .refine(email => email.slice(email.lastIndexOf('@') + 1).toLowerCase() === 'kilocode.ai');

type OutboundEmailParams = {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
  category?: string;
};

function isAutomatedTest(): boolean {
  return process.env.NODE_ENV === 'test' || !!process.env.IS_IN_AUTOMATED_TEST;
}

function getStagingSink(): string {
  const result = stagingSinkSchema.safeParse(process.env.STAGING_EMAIL_REDIRECT_TO?.trim());
  if (!result.success) {
    throw new Error(
      'STAGING_EMAIL_REDIRECT_TO must contain exactly one valid @kilocode.ai email address'
    );
  }
  return result.data;
}

export function getEmailVerificationRecipient(intendedRecipient: string): string | null {
  if (isAutomatedTest() || process.env.VERCEL_TARGET_ENV === 'production') {
    return intendedRecipient;
  }
  if (process.env.VERCEL_TARGET_ENV === 'staging') return getStagingSink();
  return null;
}

export async function sendViaMailgun(params: OutboundEmailParams): Promise<boolean> {
  const category = params.category ?? 'uncategorized';
  const targetEnvironment = process.env.VERCEL_TARGET_ENV;

  if (isAutomatedTest()) {
    console.info('[email_service] Suppressed outbound email', {
      targetEnvironment,
      category,
    });
    return true;
  }

  if (!targetEnvironment) {
    if (process.env.NODE_ENV === 'production') {
      const message = 'VERCEL_TARGET_ENV is required for production email delivery';
      console.error(message, { category });
      captureMessage(message, { level: 'error', tags: { source: 'email_service' } });
      return false;
    }

    const outboxFile = await writeEmailToLocalOutbox(params);
    console.info('[email_service] Captured outbound email locally', { category, outboxFile });
    return true;
  }

  if (targetEnvironment !== 'production' && targetEnvironment !== 'staging') {
    console.info('[email_service] Suppressed outbound email', {
      targetEnvironment,
      category,
    });
    return true;
  }

  let to = params.to;
  let subject = params.subject;
  let replyTo = params.replyTo;

  if (targetEnvironment === 'staging') {
    const sink = getStagingSink();
    to = sink;
    subject = `[STAGING to: ${params.to.replace(/[\r\n]+/g, ' ')}] ${params.subject}`;
    replyTo = sink;
  }

  if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN) {
    const message = 'MAILGUN_API_KEY/MAILGUN_DOMAIN not set — cannot send email via Mailgun';
    console.warn(message);
    captureMessage(message, { level: 'warning', tags: { source: 'email_service' } });
    return false;
  }

  const client = mailgun.client({ username: 'api', key: MAILGUN_API_KEY });
  await client.messages.create(MAILGUN_DOMAIN, {
    from: 'Kilo Code <hi@app.kilocode.ai>',
    'h:Reply-To': replyTo ?? 'hi@kilocode.ai',
    to,
    subject,
    html: params.html,
  });

  if (targetEnvironment === 'staging') {
    console.info('[email_service] Redirected outbound email to staging sink', { category });
  }
  return true;
}
