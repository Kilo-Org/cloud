import type { Organization } from '@kilocode/db/schema';
import { getMagicLinkUrl, type MagicLinkTokenWithPlaintext } from '@/lib/auth/magic-link-tokens';
import { EMAIL_PROVIDER, NEXTAUTH_URL } from '@/lib/config.server';
import { sendViaCustomerIo } from '@/lib/email-customerio';
import { sendViaMailgun, type EmailParams } from '@/lib/email-mailgun';
import * as fs from 'fs';
import * as path from 'path';

function renderTemplate(name: string, vars: Record<string, string>): string {
  const templatePath = path.join(process.cwd(), 'src', 'emails', `${name}.html`);
  const html = fs.readFileSync(templatePath, 'utf-8');
  return html.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => {
    if (!(key in vars)) {
      throw new Error(`Missing template variable '${key}' in email template '${name}'`);
    }
    return vars[key];
  });
}

function buildCreditsSection(monthlyCreditsUsd: number): string {
  if (monthlyCreditsUsd <= 0) return '';
  return `<br />• <strong style="color: #d1d5db">$${monthlyCreditsUsd} USD in Kilo credits</strong>, which reset every 30 days`;
}

function send(params: EmailParams) {
  if (EMAIL_PROVIDER === 'mailgun') {
    return sendViaMailgun(params);
  }
  return sendViaCustomerIo(params);
}

const year = String(new Date().getFullYear());

type OrganizationInviteEmailData = {
  to: string;
  inviteCode: string;
  inviterName: string;
  organizationName: Organization['name'];
  acceptInviteUrl: string;
};

type Props = {
  seatCount: number;
  organizationId: string;
};

export async function sendOrgSubscriptionEmail(to: string, props: Props) {
  const seats = `${props.seatCount} seat${props.seatCount === 1 ? '' : 's'}`;
  const organization_url = `${NEXTAUTH_URL}/organizations/${props.organizationId}`;
  const invoices_url = `${NEXTAUTH_URL}/organizations/${props.organizationId}/payment-details`;
  const html = renderTemplate('orgSubscription', { seats, organization_url, invoices_url, year });
  return send({ to, subject: 'Welcome to Kilo for Teams!', html });
}

export async function sendOrgRenewedEmail(to: string, props: Props) {
  const seats = `${props.seatCount} seat${props.seatCount === 1 ? '' : 's'}`;
  const invoices_url = `${NEXTAUTH_URL}/organizations/${props.organizationId}/payment-details`;
  const html = renderTemplate('orgRenewed', { seats, invoices_url, year });
  return send({ to, subject: 'Kilo: Your Teams Subscription Renewal', html });
}

export async function sendOrgCancelledEmail(to: string, props: Omit<Props, 'seatCount'>) {
  const invoices_url = `${NEXTAUTH_URL}/organizations/${props.organizationId}/payment-details`;
  const html = renderTemplate('orgCancelled', { invoices_url, year });
  return send({ to, subject: 'Kilo: Your Teams Subscription is Cancelled', html });
}

export async function sendOrgSSOUserJoinedEmail(
  to: string,
  props: Omit<Props, 'seatCount'> & { new_user_email: string }
) {
  const organization_url = `${NEXTAUTH_URL}/organizations/${props.organizationId}`;
  const html = renderTemplate('orgSSOUserJoined', {
    new_user_email: props.new_user_email,
    organization_url,
    year,
  });
  return send({ to, subject: 'Kilo: New SSO User Joined Your Organization', html });
}

export async function sendOrganizationInviteEmail(data: OrganizationInviteEmailData) {
  const html = renderTemplate('orgInvitation', {
    organization_name: data.organizationName,
    inviter_name: data.inviterName,
    accept_invite_url: data.acceptInviteUrl,
    year,
  });
  return send({ to: data.to, subject: 'Kilo: Teams Invitation', html });
}

export async function sendMagicLinkEmail(
  magicLink: MagicLinkTokenWithPlaintext,
  callbackUrl?: string
) {
  const html = renderTemplate('magicLink', {
    magic_link_url: getMagicLinkUrl(magicLink, callbackUrl),
    email: magicLink.email,
    expires_in: '24 hours',
    year,
  });
  return send({ to: magicLink.email, subject: 'Sign in to Kilo Code', html });
}

export async function sendAutoTopUpFailedEmail(
  to: string,
  props: { reason: string; organizationId?: string }
) {
  const credits_url = props.organizationId
    ? `${NEXTAUTH_URL}/organizations/${props.organizationId}/payment-details`
    : `${NEXTAUTH_URL}/credits?show-auto-top-up`;
  const html = renderTemplate('autoTopUpFailed', { reason: props.reason, credits_url, year });
  return send({ to, subject: 'Kilo: Auto Top-Up Failed', html });
}

type SendDeploymentFailedEmailProps = {
  to: string;
  deployment_name: string;
  deployment_url: string;
  repository: string;
};

export async function sendDeploymentFailedEmail(props: SendDeploymentFailedEmailProps) {
  const html = renderTemplate('deployFailed', {
    deployment_name: props.deployment_name,
    deployment_url: props.deployment_url,
    repository: props.repository,
    year,
  });
  return send({ to: props.to, subject: 'Kilo: Your Deployment Failed', html });
}

type SendBalanceAlertEmailProps = {
  organizationId: Organization['id'];
  minimum_balance: number;
  to: string[];
};

export async function sendBalanceAlertEmail(props: SendBalanceAlertEmailProps) {
  const { organizationId, minimum_balance, to } = props;

  if (!to || to.length === 0) {
    console.warn(
      `[sendBalanceAlertEmail] No recipients configured for organization ${organizationId} - skipping email`
    );
    return;
  }

  const organization_url = `${NEXTAUTH_URL}/organizations/${organizationId}`;
  const html = renderTemplate('balanceAlert', {
    minimum_balance: String(minimum_balance),
    organization_url,
    year,
  });

  const sendToRecipient = (email: string) =>
    send({ to: email, subject: 'Kilo: Low Balance Alert', html });

  // Batch emails in groups of 10
  const BATCH_SIZE = 10;
  for (let i = 0; i < to.length; i += BATCH_SIZE) {
    const batch = to.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(sendToRecipient));
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
  inviteCode: string;
  tier: OssTier;
  monthlyCreditsUsd: number;
};

export async function sendOssInviteNewUserEmail(data: OssInviteEmailData) {
  const integrations_url = `${NEXTAUTH_URL}/organizations/${data.organizationId}/integrations`;
  const code_reviews_url = `${NEXTAUTH_URL}/organizations/${data.organizationId}/code-reviews`;
  const tierConfig = ossTierConfig[data.tier];
  const html = renderTemplate('ossInviteNewUser', {
    tier_name: tierConfig.name,
    seats: String(tierConfig.seats),
    seat_value: tierConfig.seatValue.toLocaleString(),
    credits_section: buildCreditsSection(data.monthlyCreditsUsd),
    accept_invite_url: data.acceptInviteUrl,
    integrations_url,
    code_reviews_url,
    year,
  });
  return send({ to: data.to, subject: 'Kilo: OSS Sponsorship Offer', html });
}

export async function sendOssInviteExistingUserEmail(
  data: Omit<OssInviteEmailData, 'acceptInviteUrl' | 'inviteCode'>
) {
  const organization_url = `${NEXTAUTH_URL}/organizations/${data.organizationId}`;
  const integrations_url = `${NEXTAUTH_URL}/organizations/${data.organizationId}/integrations`;
  const code_reviews_url = `${NEXTAUTH_URL}/organizations/${data.organizationId}/code-reviews`;
  const tierConfig = ossTierConfig[data.tier];
  const html = renderTemplate('ossInviteExistingUser', {
    tier_name: tierConfig.name,
    seats: String(tierConfig.seats),
    seat_value: tierConfig.seatValue.toLocaleString(),
    credits_section: buildCreditsSection(data.monthlyCreditsUsd),
    organization_url,
    integrations_url,
    code_reviews_url,
    year,
  });
  return send({ to: data.to, subject: 'Kilo: OSS Sponsorship Offer', html });
}

type OssProvisionEmailData = {
  to: string[];
  organizationName: string;
  organizationId: string;
  tier: OssTier;
  monthlyCreditsUsd: number;
};

export async function sendOssExistingOrgProvisionedEmail(data: OssProvisionEmailData) {
  const organization_url = `${NEXTAUTH_URL}/organizations/${data.organizationId}`;
  const integrations_url = `${NEXTAUTH_URL}/organizations/${data.organizationId}/integrations`;
  const code_reviews_url = `${NEXTAUTH_URL}/organizations/${data.organizationId}/code-reviews`;
  const tierConfig = ossTierConfig[data.tier];
  const html = renderTemplate('ossExistingOrgProvisioned', {
    tier_name: tierConfig.name,
    seats: String(tierConfig.seats),
    seat_value: tierConfig.seatValue.toLocaleString(),
    credits_section: buildCreditsSection(data.monthlyCreditsUsd),
    organization_url,
    integrations_url,
    code_reviews_url,
    year,
  });

  await Promise.all(
    data.to.map(email => send({ to: email, subject: 'Kilo: OSS Sponsorship Offer', html }))
  );
}

// Exported for use in the admin email testing page
export { renderTemplate, buildCreditsSection };
