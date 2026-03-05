import { CUSTOMERIO_EMAIL_API_KEY } from '@/lib/config.server';
import { captureMessage } from '@sentry/nextjs';
import { APIClient, SendEmailRequest } from 'customerio-node';
import type { EmailParams } from '@/lib/email-mailgun';

export function sendViaCustomerIo(params: EmailParams) {
  if (!CUSTOMERIO_EMAIL_API_KEY) {
    const message = 'CUSTOMERIO_EMAIL_API_KEY is not set - cannot send email';
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
    'sending email with customerio: ',
    JSON.stringify({ to: params.to, subject: params.subject })
  );
  const client = new APIClient(CUSTOMERIO_EMAIL_API_KEY);
  const request = new SendEmailRequest({
    to: params.to,
    identifiers: { email: params.to },
    subject: params.subject,
    body: params.html,
    from: 'Kilo Code <hi@kilocode.ai>',
    reply_to: 'hi@kilocode.ai',
  });
  return client.sendEmail(request);
}
