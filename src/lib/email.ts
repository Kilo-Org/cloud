import fs from 'fs';
import path from 'path';
import type { Organization } from '@kilocode/db/schema';
import { getMagicLinkUrl, type MagicLinkTokenWithPlaintext } from '@/lib/auth/magic-link-tokens';
import { NEXTAUTH_URL } from '@/lib/config.server';
import { sendViaMailgun } from '@/lib/email-mailgun';
import { verifyEmail } from '@/lib/email-neverbounce';

// Subject lines for each template — also serves as the canonical list of template names
export const subjects = {
  orgSubscription: 'Welcome to Kilo for Teams!',
  orgRenewed: 'Kilo: Your Teams Subscription Renewal',
  orgCancelled: 'Kilo: Your Teams Subscription is Cancelled',
  orgSSOUserJoined: 'Kilo: New SSO User Joined Your Organization',
  orgInvitation: 'Kilo: Teams Invitation',
  magicLink: 'Sign in to Kilo Code',
  balanceAlert: 'Kilo: Low Balance Alert',
  autoTopUpFailed: 'Kilo: Auto Top-Up Failed',
  ossInviteNewUser: 'Kilo: OSS Sponsorship Offer',
  ossInviteExistingUser: 'Kilo: OSS Sponsorship Offer',
  ossExistingOrgProvisioned: 'Kilo: OSS Sponsorship Offer',
  deployFailed: 'Kilo: Your Deployment Failed',
  clawTrialEndingSoon: 'Your KiloClaw Trial Ends in 2 Days',
  clawTrialExpiresTomorrow: 'Your KiloClaw Trial Expires Tomorrow',
  clawSuspendedTrial: 'Your KiloClaw Trial Has Ended',
  clawSuspendedSubscription: 'Your KiloClaw Subscription Has Ended',
  clawSuspendedPayment: 'Action Required: KiloClaw Payment Overdue',
  clawDestructionWarning: 'Your KiloClaw Instance Will Be Deleted in 2 Days',
  clawInstanceDestroyed: 'Your KiloClaw Instance Has Been Deleted',
  clawEarlybirdEndingSoon: 'Your KiloClaw Earlybird Access Ends Soon',
  clawEarlybirdExpiresTomorrow: 'Your KiloClaw Earlybird Access Expires Tomorrow',
  clawInstanceReady: 'Your KiloClaw Instance Is Ready',
} as const;

export type TemplateName = keyof typeof subjects;

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Variables wrapped in RawHtml are interpolated without HTML escaping.
// Use only for values that are already trusted HTML (e.g. credits_section).
export class RawHtml {
  constructor(public readonly html: string) {}
}

type TemplateVars = Record<string, string | RawHtml>;

export function renderTemplate(name: string, vars: TemplateVars): string {
  const templatePath = path.join(process.cwd(), 'src', 'emails', `${name}.html`);
  const html = fs.readFileSync(templatePath, 'utf-8');
  return html.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => {
    if (!(key in vars)) {
      throw new Error(`Missing template variable '${key}' in email template '${name}'`);
    }
    const value = vars[key];
    return value instanceof RawHtml ? value.html : escapeHtml(value);
  });
}

export function buildCreditsSection(monthlyCreditsUsd: number): RawHtml {
  if (monthlyCreditsUsd <= 0) return new RawHtml('');
  return new RawHtml(
    `<br />• <strong style="color: #d1d5db">$${monthlyCreditsUsd} USD in Kilo credits</strong>, which reset every 30 days`
  );
}

export function creditsVars(monthlyCreditsUsd: number): TemplateVars {
  return {
    credits_section: buildCreditsSection(monthlyCreditsUsd),
  };
}

export type SendResult =
  | { sent: true }
  | { sent: false; reason: 'neverbounce_rejected' | 'provider_not_configured' };

type SendParams = {
  to: string;
  templateName: TemplateName;
  templateVars: TemplateVars;
  subjectOverride?: string;
};

export async function send(params: SendParams): Promise<SendResult> {
  const isSafeToSend = await verifyEmail(params.to);
  if (!isSafeToSend) {
    return { sent: false, reason: 'neverbounce_rejected' };
  }

  const subject = params.subjectOverride ?? subjects[params.templateName];
  const html = renderTemplate(params.templateName, {
    ...params.templateVars,
    year: String(new Date().getFullYear()),
  });
  const result = await sendViaMailgun({ to: params.to, subject, html });
  if (!result) return { sent: false, reason: 'provider_not_configured' as const };
  return { sent: true };
}

type OrganizationInviteEmailData = {
  to: string;
  inviterName: string;
  organizationName: Organization['name'];
  acceptInviteUrl: string;
};

type Props = {
  seatCount: number;
  organizationId: string;
};

export async function sendOrgSubscriptionEmail(to: string, props: Props): Promise<SendResult> {
  const seats = `${props.seatCount} seat${props.seatCount === 1 ? '' : 's'}`;
  const organization_url = `${NEXTAUTH_URL}/organizations/${props.organizationId}`;
  const invoices_url = `${NEXTAUTH_URL}/organizations/${props.organizationId}/payment-details`;
  return send({
    to,
    templateName: 'orgSubscription',
    templateVars: { seats, organization_url, invoices_url },
  });
}

export async function sendOrgRenewedEmail(to: string, props: Props): Promise<SendResult> {
  const seats = `${props.seatCount} seat${props.seatCount === 1 ? '' : 's'}`;
  const invoices_url = `${NEXTAUTH_URL}/organizations/${props.organizationId}/payment-details`;
  return send({
    to,
    templateName: 'orgRenewed',
    templateVars: { seats, invoices_url },
  });
}

export async function sendOrgCancelledEmail(
  to: string,
  props: Omit<Props, 'seatCount'>
): Promise<SendResult> {
  const invoices_url = `${NEXTAUTH_URL}/organizations/${props.organizationId}/payment-details`;
  return send({
    to,
    templateName: 'orgCancelled',
    templateVars: { invoices_url },
  });
}

export async function sendOrgSSOUserJoinedEmail(
  to: string,
  props: Omit<Props, 'seatCount'> & { new_user_email: string }
): Promise<SendResult> {
  const organization_url = `${NEXTAUTH_URL}/organizations/${props.organizationId}`;
  return send({
    to,
    templateName: 'orgSSOUserJoined',
    templateVars: { new_user_email: props.new_user_email, organization_url },
  });
}

export async function sendOrganizationInviteEmail(
  data: OrganizationInviteEmailData
): Promise<SendResult> {
  return send({
    to: data.to,
    templateName: 'orgInvitation',
    templateVars: {
      organization_name: data.organizationName,
      inviter_name: data.inviterName,
      accept_invite_url: data.acceptInviteUrl,
    },
  });
}

export async function sendMagicLinkEmail(
  magicLink: MagicLinkTokenWithPlaintext,
  callbackUrl?: string
): Promise<SendResult> {
  return send({
    to: magicLink.email,
    templateName: 'magicLink',
    templateVars: {
      magic_link_url: getMagicLinkUrl(magicLink, callbackUrl),
      email: magicLink.email,
      expires_in: '24 hours',
      expires_at: new Date(magicLink.expires_at).toISOString(),
      app_url: NEXTAUTH_URL,
    },
  });
}

export async function sendAutoTopUpFailedEmail(
  to: string,
  props: { reason: string; organizationId?: string }
): Promise<SendResult> {
  const credits_url = props.organizationId
    ? `${NEXTAUTH_URL}/organizations/${props.organizationId}/payment-details`
    : `${NEXTAUTH_URL}/credits?show-auto-top-up`;
  return send({
    to,
    templateName: 'autoTopUpFailed',
    templateVars: { reason: props.reason, credits_url },
  });
}

type SendDeploymentFailedEmailProps = {
  to: string;
  deployment_name: string;
  deployment_url: string;
  repository: string;
};

export async function sendDeploymentFailedEmail(
  props: SendDeploymentFailedEmailProps
): Promise<SendResult> {
  return send({
    to: props.to,
    templateName: 'deployFailed',
    templateVars: {
      deployment_name: props.deployment_name,
      deployment_url: props.deployment_url,
      repository: props.repository,
    },
  });
}

type SendBalanceAlertEmailProps = {
  organizationId: Organization['id'];
  minimum_balance: number;
  to: string[];
};

export async function sendBalanceAlertEmail(props: SendBalanceAlertEmailProps): Promise<void> {
  const { organizationId, minimum_balance, to } = props;

  if (!to || to.length === 0) {
    console.warn(
      `[sendBalanceAlertEmail] No recipients configured for organization ${organizationId} - skipping email`
    );
    return;
  }

  const organization_url = `${NEXTAUTH_URL}/organizations/${organizationId}`;

  const sendToRecipient = (email: string) =>
    send({
      to: email,
      templateName: 'balanceAlert',
      templateVars: {
        minimum_balance: String(minimum_balance),
        organization_url,
      },
    });

  const BATCH_SIZE = 10;
  for (let i = 0; i < to.length; i += BATCH_SIZE) {
    await Promise.all(to.slice(i, i + BATCH_SIZE).map(sendToRecipient));
  }
}

const ossTierConfig = {
  1: { name: 'Premier', seats: 25, seatValue: 48000 },
  2: { name: 'Growth', seats: 15, seatValue: 27000 },
  3: { name: 'Seed', seats: 5, seatValue: 9000 },
} as const;

type OssTier = 1 | 2 | 3;

type OssInviteEmailData = {
  to: string;
  organizationName: string;
  organizationId: string;
  acceptInviteUrl: string;
  tier: OssTier;
  monthlyCreditsUsd: number;
};

export async function sendOssInviteNewUserEmail(data: OssInviteEmailData): Promise<SendResult> {
  const integrations_url = `${NEXTAUTH_URL}/organizations/${data.organizationId}/integrations`;
  const code_reviews_url = `${NEXTAUTH_URL}/organizations/${data.organizationId}/code-reviews`;
  const tierConfig = ossTierConfig[data.tier];
  return send({
    to: data.to,
    templateName: 'ossInviteNewUser',
    templateVars: {
      organization_name: data.organizationName,
      accept_invite_url: data.acceptInviteUrl,
      integrations_url,
      code_reviews_url,
      tier_name: tierConfig.name,
      seats: String(tierConfig.seats),
      seat_value: tierConfig.seatValue.toLocaleString(),
      ...creditsVars(data.monthlyCreditsUsd),
    },
  });
}

export async function sendOssInviteExistingUserEmail(
  data: Omit<OssInviteEmailData, 'acceptInviteUrl' | 'inviteCode'>
): Promise<SendResult> {
  const organization_url = `${NEXTAUTH_URL}/organizations/${data.organizationId}`;
  const integrations_url = `${NEXTAUTH_URL}/organizations/${data.organizationId}/integrations`;
  const code_reviews_url = `${NEXTAUTH_URL}/organizations/${data.organizationId}/code-reviews`;
  const tierConfig = ossTierConfig[data.tier];
  return send({
    to: data.to,
    templateName: 'ossInviteExistingUser',
    templateVars: {
      organization_name: data.organizationName,
      organization_url,
      integrations_url,
      code_reviews_url,
      tier_name: tierConfig.name,
      seats: String(tierConfig.seats),
      seat_value: tierConfig.seatValue.toLocaleString(),
      ...creditsVars(data.monthlyCreditsUsd),
    },
  });
}

type OssProvisionEmailData = {
  to: string[];
  organizationName: string;
  organizationId: string;
  tier: OssTier;
  monthlyCreditsUsd: number;
};

export async function sendOssExistingOrgProvisionedEmail(
  data: OssProvisionEmailData
): Promise<void> {
  const organization_url = `${NEXTAUTH_URL}/organizations/${data.organizationId}`;
  const integrations_url = `${NEXTAUTH_URL}/organizations/${data.organizationId}/integrations`;
  const code_reviews_url = `${NEXTAUTH_URL}/organizations/${data.organizationId}/code-reviews`;
  const tierConfig = ossTierConfig[data.tier];
  const templateVars = {
    organization_name: data.organizationName,
    organization_url,
    integrations_url,
    code_reviews_url,
    tier_name: tierConfig.name,
    seats: String(tierConfig.seats),
    seat_value: tierConfig.seatValue.toLocaleString(),
    ...creditsVars(data.monthlyCreditsUsd),
  };
  await Promise.all(
    data.to.map(to => send({ to, templateName: 'ossExistingOrgProvisioned', templateVars }))
  );
}
