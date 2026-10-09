import { NEXTAUTH_URL } from '@kilocode/web-shared/lib/config.server';
import { renderTemplate, type SendResult } from '@kilocode/web-shared/lib/email';
import {
  getEmailVerificationRecipient,
  sendViaMailgun,
} from '@kilocode/web-shared/lib/email-mailgun';
import { verifyEmail } from '@kilocode/web-shared/lib/email-neverbounce';

export async function sendStoreCreditWebTipEmail(to: string): Promise<SendResult> {
  const verificationRecipient = getEmailVerificationRecipient(to);
  if (verificationRecipient && !(await verifyEmail(verificationRecipient))) {
    return { sent: false, reason: 'neverbounce_rejected' };
  }

  const html = renderTemplate(
    'storeCreditWebTip',
    { credits_url: `${NEXTAUTH_URL}/credits`, year: String(new Date().getFullYear()) },
    'marketing-emails'
  );
  const sent = await sendViaMailgun({
    to,
    subject: 'A tip for your next Kilo top-up',
    html,
    category: 'storeCreditWebTip',
    marketingTag: 'marketing',
  });
  return sent ? { sent: true } : { sent: false, reason: 'provider_not_configured' };
}
