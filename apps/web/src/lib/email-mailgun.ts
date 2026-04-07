import Mailgun from 'mailgun.js';
import FormData from 'form-data';
import { MAILGUN_API_KEY, MAILGUN_DOMAIN } from '@/lib/config.server';
import { captureMessage } from '@sentry/nextjs';

const mailgun = new Mailgun(FormData);

type SendViaMailgunParams = {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
};

export async function sendViaMailgun({
  to,
  subject,
  html,
  replyTo,
}: SendViaMailgunParams): Promise<boolean> {
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
    html,
  });
  return true;
}
