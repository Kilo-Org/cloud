import type { Organization } from '@/db/schema';
import { getMagicLinkUrl, type MagicLinkTokenWithPlaintext } from '@/lib/auth/magic-link-tokens';
import { CUSTOMERIO_EMAIL_API_KEY, NEXTAUTH_URL } from '@/lib/config.server';
import { captureMessage } from '@sentry/nextjs';

import { APIClient, SendEmailRequest } from 'customerio-node';
import type { SendEmailRequestOptions } from 'customerio-node/dist/lib/api/requests';

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

function send(mailRequest: SendEmailRequestOptions) {
  if (!CUSTOMERIO_EMAIL_API_KEY) {
    const message = 'CUSTOMERIO_EMAIL_API_KEY is not set - cannot send email';
    console.warn(message);
    console.warn(JSON.stringify(mailRequest));

    captureMessage(message, {
      level: 'warning',
      tags: { source: 'email_service' },
      extra: {
        mailRequest,
      },
    });
    return;
  }
  console.log('sending email with customerio: ', JSON.stringify(mailRequest));
  const client = new APIClient(CUSTOMERIO_EMAIL_API_KEY);
  const request = new SendEmailRequest(mailRequest);
  return client.sendEmail(request);
}

const teamplates = {
  orgSubscription: '10',
  orgRenewed: '11',
  orgCancelled: '12',
  orgSSOUserJoined: '13',
  orgInvitation: '6',
  magicLink: '14',
  balanceAlert: '16',
  autoTopUpFailed: '17',
  ossInviteNewUser: '18',
  ossInviteExistingUser: '19',
  ossExistingOrgProvisioned: '20',
  deployFailed: '21',
} as const;

type Template = (typeof teamplates)[keyof typeof teamplates];

type SendOrgEmailProps = {
  organizationId: Organization['id'];
  seats?: number;
};

function sendOrgEmail(transactionalMessageId: Template, to: string, props: SendOrgEmailProps) {
  const seats = props.seats ? `${props.seats} seat${props.seats === 1 ? '' : 's'}` : undefined;
  const organization_url = `${NEXTAUTH_URL}/organizations/${props.organizationId}`;
  const invoices_url = `${NEXTAUTH_URL}/organizations/${props.organizationId}/payment-details`;

  const mailRequest: SendEmailRequestOptions = {
    // this is the id of the email in customerio - do not change this
    transactional_message_id: transactionalMessageId,
    to,
    message_data: {
      ...props,
      seats,
      organization_url,
      invoices_url,
    },
    identifiers: {
      email: to,
    },
    reply_to: 'hi@kilocode.ai',
  };
  return send(mailRequest);
}

export async function sendOrgSSOUserJoinedEmail(
  to: string,
  props: Omit<Props, 'seatCount'> & { new_user_email: string }
) {
  return sendOrgEmail(teamplates.orgSSOUserJoined, to, props);
}

export async function sendOrgCancelledEmail(to: string, props: Omit<Props, 'seatCount'>) {
  return sendOrgEmail(teamplates.orgCancelled, to, props);
}

export async function sendOrgRenewedEmail(to: string, props: Props) {
  return sendOrgEmail(teamplates.orgRenewed, to, props);
}

export async function sendOrgSubscriptionEmail(to: string, props: Props) {
  return sendOrgEmail(teamplates.orgSubscription, to, props);
}

export async function sendOrganizationInviteEmail(data: OrganizationInviteEmailData) {
  const mailRequest: SendEmailRequestOptions = {
    // this is the id of the email in customerio - do not change this
    transactional_message_id: teamplates.orgInvitation,
    message_data: {
      organization_name: data.organizationName,
      inviter_name: data.inviterName,
      accept_invite_url: data.acceptInviteUrl,
    },
    identifiers: {
      id: data.inviteCode,
    },
    reply_to: 'hi@kilocode.ai',
    to: data.to,
  };

  return await send(mailRequest);
}

/**
 * Send a magic link email to the user.
 *
 * @param magicLink - The magic link token with plaintext
 * @param callbackUrl - Optional callback URL to preserve redirect path
 * @returns Promise that resolves when email is sent
 */
export async function sendMagicLinkEmail(
  magicLink: MagicLinkTokenWithPlaintext,
  callbackUrl?: string
) {
  const expiresIn = '24 hours';

  const mailRequest: SendEmailRequestOptions = {
    transactional_message_id: teamplates.magicLink,
    to: magicLink.email,
    message_data: {
      magic_link_url: getMagicLinkUrl(magicLink, callbackUrl),
      email: magicLink.email,
      expires_in: expiresIn,
      expires_at: new Date(magicLink.expires_at).toISOString(),
      app_url: NEXTAUTH_URL,
    },
    identifiers: {
      email: magicLink.email,
    },
    reply_to: 'hi@kilocode.ai',
  };

  return send(mailRequest);
}
export async function sendAutoTopUpFailedEmail(to: string, props: { reason: string }) {
  return send({
    transactional_message_id: teamplates.autoTopUpFailed,
    to,
    message_data: {
      reason: props.reason,
      credits_url: `${NEXTAUTH_URL}/credits?show-auto-top-up`,
    },
    identifiers: {
      email: to,
    },
    reply_to: 'hi@kilocode.ai',
  });
}

type SendDeploymentFailedEmailProps = {
  to: string;
  deployment_name: string;
  deployment_url: string;
  repository: string;
};

export async function sendDeploymentFailedEmail(props: SendDeploymentFailedEmailProps) {
  return send({
    transactional_message_id: teamplates.deployFailed,
    to: props.to,
    message_data: {
      deployment_name: props.deployment_name,
      deployment_url: props.deployment_url,
      repository: props.repository,
    },
    identifiers: {
      email: props.to,
    },
    reply_to: 'hi@kilocode.ai',
  });
}

type SendBalanceAlertEmailProps = {
  organizationId: Organization['id'];
  minimum_balance: number;
  to: string[];
};

/**
 * Send a balance alert email to the configured recipients.
 * Batches emails in groups of 10 using Promise.all.
 *
 * @param props - The email properties including organizationId, minimum_balance, and recipient list
 * @returns Promise that resolves when all emails are sent
 */
export async function sendBalanceAlertEmail(props: SendBalanceAlertEmailProps) {
  const { organizationId, minimum_balance, to } = props;

  if (!to || to.length === 0) {
    console.warn(
      `[sendBalanceAlertEmail] No recipients configured for organization ${organizationId} - skipping email`
    );
    return;
  }

  const organization_url = `${NEXTAUTH_URL}/organizations/${organizationId}`;
  const invoices_url = `${NEXTAUTH_URL}/organizations/${organizationId}/payment-details`;

  const sendToRecipient = async (email: string) => {
    const mailRequest: SendEmailRequestOptions = {
      transactional_message_id: teamplates.balanceAlert,
      to: email,
      message_data: {
        organizationId,
        minimum_balance,
        organization_url,
        invoices_url,
      },
      identifiers: {
        email,
      },
      reply_to: 'hi@kilocode.ai',
    };
    return send(mailRequest);
  };

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

/**
 * Send an OSS invite email to a new user (doesn't have a Kilo account yet).
 * They need to click the accept button to sign up and join the org.
 *
 * Template 18 variables:
 * - organization_name: Name of the organization
 * - accept_invite_url: Link to accept the invitation
 * - integrations_url: Link to integrations page
 * - code_reviews_url: Link to code reviews page
 * - tier_name: "Premier", "Growth", or "Seed"
 * - seats: Number of enterprise seats (5, 15, or 25)
 * - seat_value: Dollar value of the seats ($9,000, $27,000, or $48,000)
 * - has_credits: Boolean - true if monthly credits > 0
 * - monthly_credits_usd: Dollar amount for monthly credit top-up (only relevant if has_credits)
 */
export async function sendOssInviteNewUserEmail(data: OssInviteEmailData) {
  const integrations_url = `${NEXTAUTH_URL}/organizations/${data.organizationId}/integrations`;
  const code_reviews_url = `${NEXTAUTH_URL}/organizations/${data.organizationId}/code-reviews`;
  const tierConfig = ossTierConfig[data.tier];

  const mailRequest: SendEmailRequestOptions = {
    transactional_message_id: teamplates.ossInviteNewUser,
    to: data.to,
    message_data: {
      organization_name: data.organizationName,
      accept_invite_url: data.acceptInviteUrl,
      integrations_url,
      code_reviews_url,
      tier_name: tierConfig.name,
      seats: tierConfig.seats,
      seat_value: tierConfig.seatValue.toLocaleString(),
      has_credits: data.monthlyCreditsUsd > 0,
      monthly_credits_usd: data.monthlyCreditsUsd,
    },
    identifiers: {
      id: data.inviteCode,
    },
    reply_to: 'hi@kilocode.ai',
  };

  return send(mailRequest);
}

/**
 * Send an OSS invite email to an existing Kilo user.
 * They've been directly added to the org, they just need to sign in.
 *
 * Template 19 variables:
 * - organization_name: Name of the organization
 * - organization_url: Link to the organization dashboard
 * - integrations_url: Link to integrations page
 * - code_reviews_url: Link to code reviews page
 * - tier_name: "Premier", "Growth", or "Seed"
 * - seats: Number of enterprise seats (5, 15, or 25)
 * - seat_value: Dollar value of the seats ($9,000, $27,000, or $48,000)
 * - has_credits: Boolean - true if monthly credits > 0
 * - monthly_credits_usd: Dollar amount for monthly credit top-up (only relevant if has_credits)
 */
export async function sendOssInviteExistingUserEmail(
  data: Omit<OssInviteEmailData, 'acceptInviteUrl' | 'inviteCode'>
) {
  const organization_url = `${NEXTAUTH_URL}/organizations/${data.organizationId}`;
  const integrations_url = `${NEXTAUTH_URL}/organizations/${data.organizationId}/integrations`;
  const code_reviews_url = `${NEXTAUTH_URL}/organizations/${data.organizationId}/code-reviews`;
  const tierConfig = ossTierConfig[data.tier];

  const mailRequest: SendEmailRequestOptions = {
    transactional_message_id: teamplates.ossInviteExistingUser,
    to: data.to,
    message_data: {
      organization_name: data.organizationName,
      organization_url,
      integrations_url,
      code_reviews_url,
      tier_name: tierConfig.name,
      seats: tierConfig.seats,
      seat_value: tierConfig.seatValue.toLocaleString(),
      has_credits: data.monthlyCreditsUsd > 0,
      monthly_credits_usd: data.monthlyCreditsUsd,
    },
    identifiers: {
      email: data.to,
    },
    reply_to: 'hi@kilocode.ai',
  };

  return send(mailRequest);
}

type OssProvisionEmailData = {
  to: string[];
  organizationName: string;
  organizationId: string;
  tier: OssTier;
  monthlyCreditsUsd: number;
};

/**
 * Send an OSS provisioning notification email to owners of an existing organization.
 * Used when an admin enables OSS sponsorship on an existing org from the admin panel.
 *
 * Template 20 variables (same as template 19):
 * - organization_name: Name of the organization
 * - organization_url: Link to the organization dashboard
 * - integrations_url: Link to integrations page
 * - code_reviews_url: Link to code reviews page
 * - tier_name: "Premier", "Growth", or "Seed"
 * - seats: Number of enterprise seats (5, 15, or 25)
 * - seat_value: Dollar value of the seats ($9,000, $27,000, or $48,000)
 * - has_credits: Boolean - true if monthly credits > 0
 * - monthly_credits_usd: Dollar amount for monthly credit top-up (only relevant if has_credits)
 */
export async function sendOssExistingOrgProvisionedEmail(data: OssProvisionEmailData) {
  const organization_url = `${NEXTAUTH_URL}/organizations/${data.organizationId}`;
  const integrations_url = `${NEXTAUTH_URL}/organizations/${data.organizationId}/integrations`;
  const code_reviews_url = `${NEXTAUTH_URL}/organizations/${data.organizationId}/code-reviews`;
  const tierConfig = ossTierConfig[data.tier];

  const sendToRecipient = async (email: string) => {
    const mailRequest: SendEmailRequestOptions = {
      transactional_message_id: teamplates.ossExistingOrgProvisioned,
      to: email,
      message_data: {
        organization_name: data.organizationName,
        organization_url,
        integrations_url,
        code_reviews_url,
        tier_name: tierConfig.name,
        seats: tierConfig.seats,
        seat_value: tierConfig.seatValue.toLocaleString(),
        has_credits: data.monthlyCreditsUsd > 0,
        monthly_credits_usd: data.monthlyCreditsUsd,
      },
      identifiers: {
        email,
      },
      reply_to: 'hi@kilocode.ai',
    };
    return send(mailRequest);
  };

  // Send to all recipients
  await Promise.all(data.to.map(sendToRecipient));
}
