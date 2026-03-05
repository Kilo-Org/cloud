import { MAILGUN_API_KEY, MAILGUN_DOMAIN } from '@/lib/config.server';
import { captureMessage } from '@sentry/nextjs';
import Mailgun from 'mailgun.js';
import FormData from 'form-data';

export type EmailParams = {
  to: string;
  subject: string;
  html: string;
};

export async function sendViaMailgun(params: EmailParams) {
  if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN) {
    const message = 'MAILGUN_API_KEY or MAILGUN_DOMAIN is not set - cannot send email';
    console.warn(message);
    console.warn(JSON.stringify({ to: params.to, subject: params.subject }));
    captureMessage(message, {
      level: 'warning',
      tags: { source: 'email_service' },
      extra: { to: params.to, subject: params.subject },
    });
    return;
  }

  console.log(
    'sending email with mailgun: ',
    JSON.stringify({ to: params.to, subject: params.subject })
  );
  const mailgun = new Mailgun(FormData);
  const client = mailgun.client({ username: 'api', key: MAILGUN_API_KEY });

  return client.messages.create(MAILGUN_DOMAIN, {
    from: 'Kilo Code <hi@kilocode.ai>',
    to: params.to,
    subject: params.subject,
    html: params.html,
    'h:Reply-To': 'hi@kilocode.ai',
  });
}
