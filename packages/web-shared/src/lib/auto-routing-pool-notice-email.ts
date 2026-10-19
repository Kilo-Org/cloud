import { NEXTAUTH_URL } from '@kilocode/web-shared/lib/config.server';
import { escapeHtml, RawHtml, renderTemplate, subjects } from '@kilocode/web-shared/lib/email';
import type { SendResult } from '@kilocode/web-shared/lib/email';
import {
  getEmailVerificationRecipient,
  sendViaMailgun,
} from '@kilocode/web-shared/lib/email-mailgun';
import { verifyEmail } from '@kilocode/web-shared/lib/email-neverbounce';

export type AutoRoutingPoolNoticeRouter = {
  id: string;
  modelId: string;
  organization: { id: string; name: string } | null;
};

export async function sendAutoRoutingPoolNoticeEmail(params: {
  to: string;
  cutoverAt: string;
  routers: AutoRoutingPoolNoticeRouter[];
}): Promise<SendResult> {
  const verificationRecipient = getEmailVerificationRecipient(params.to);
  if (
    verificationRecipient &&
    !(await verifyEmail(verificationRecipient, { suppressDiagnostics: true }))
  ) {
    return { sent: false, reason: 'neverbounce_rejected' };
  }
  const routers = params.routers.map(router => {
    const label = router.organization ? router.organization.name : 'Your personal pool';
    const settingsUrl = router.organization
      ? `${NEXTAUTH_URL}/organizations/${encodeURIComponent(router.organization.id)}/providers-and-models`
      : `${NEXTAUTH_URL}/profile`;
    return `<li style="margin: 0 0 12px"><strong>${escapeHtml(label)}</strong><br /><code>${escapeHtml(router.modelId)}</code><br /><a href="${escapeHtml(settingsUrl)}" style="color: #1a1a1a; text-decoration: underline">Manage this pool</a></li>`;
  });
  const cutoverAt = new Intl.DateTimeFormat('en-US', {
    dateStyle: 'full',
    timeStyle: 'long',
    timeZone: 'UTC',
  }).format(new Date(params.cutoverAt));
  const html = renderTemplate('autoRoutingPoolNotice', {
    cutover_at: `${cutoverAt} (${params.cutoverAt})`,
    routers: new RawHtml(routers.join('')),
    year: String(new Date().getFullYear()),
  });
  const sent = await sendViaMailgun({
    to: params.to,
    subject: subjects.autoRoutingPoolNotice,
    html,
    category: 'autoRoutingPoolNotice',
  });
  return sent ? { sent: true } : { sent: false, reason: 'provider_not_configured' };
}
