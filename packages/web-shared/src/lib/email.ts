import fs from 'fs';
import path from 'path';
import { SUPPORT_EMAIL } from '@kilocode/app-shared/support';
import { replaceQuoteMarks } from '@kilocode/notifications/schemas';
import type { Organization } from '@kilocode/db/schema';
import { captureException } from '@sentry/nextjs';
import {
  getMagicLinkUrl,
  SIGN_IN_CODE_EXPIRY_MINUTES,
  type MagicLinkTokenWithPlaintext,
} from '@kilocode/web-shared/lib/auth/magic-link-tokens';
import { NEXTAUTH_URL } from '@kilocode/web-shared/lib/config.server';
import {
  getEmailVerificationRecipient,
  sendViaMailgun,
} from '@kilocode/web-shared/lib/email-mailgun';
import { verifyEmail } from '@kilocode/web-shared/lib/email-neverbounce';
import { logExceptInTest, warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { USER_DELETION_COMPLETION_HTML } from '@kilocode/web-shared/lib/user/deletion-queue/deletion-constants';

// Subject lines for each template — also serves as the canonical list of template names
export const subjects = {
  orgSubscription: 'Welcome to Kilo for Teams!',
  orgRenewed: 'Kilo: Your Teams Subscription Renewal',
  orgCancelled: 'Kilo: Your Teams Subscription is Cancelled',
  orgSSOUserJoined: 'Kilo: New SSO User Joined Your Organization',
  orgInvitation: 'Kilo: Teams Invitation',
  magicLink: 'Sign in to Kilo Code',
  signInCode: 'Your Kilo Code sign-in code',
  accountLinkCode: 'Kilo: Confirm adding a sign-in method',
  newSignInMethod: 'Kilo: A new sign-in method was added to your account',
  signInMethodRemoved: 'Kilo: A sign-in method was removed from your account',
  passkeyAdded: 'Kilo: A passkey was added to your account',
  passkeyRemoved: 'Kilo: A passkey was removed from your account',
  deviceSignInApproved: 'Kilo: A device sign-in was approved for your account',
  apiKeyReset: 'Kilo: Your API token was reset',
  browserSessionsRevoked: 'Kilo: You were signed out of all browsers',
  deviceSessionRevoked: 'Kilo: A device was signed out of your account',
  signInResetBySupport: 'Kilo: Kilo support reset how you sign in',
  newSignIn: 'Kilo: New sign-in to your account',
  signInMethodChangeCode: 'Kilo: Your code to change a sign-in method',
  balanceAlert: 'Kilo: Low Balance Alert',
  spendAlert: 'Kilo: Spend alert',
  autoTopUpFailed: 'Kilo: Auto Top-Up Failed',
  codeReviewDisabled: 'Action Required: Code Reviewer Disabled',
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
  clawOrganizationTrialSuspendedBillingAuthority:
    'Action Required: Organization KiloClaw Instance Suspended',
  clawOrganizationTrialSuspendedUser: 'Organization KiloClaw Instance Suspended',
  clawOrganizationDestructionWarningBillingAuthority:
    'Action Required: Organization KiloClaw Instance Will Be Deleted in 2 Days',
  clawOrganizationDestructionWarningUser:
    'Organization KiloClaw Instance Will Be Deleted in 2 Days',
  clawOrganizationInstanceDestroyedBillingAuthority:
    'Organization KiloClaw Instance Has Been Deleted',
  clawOrganizationInstanceDestroyedUser: 'Organization KiloClaw Instance Has Been Deleted',
  clawEarlybirdEndingSoon: 'Your KiloClaw Earlybird Access Ends Soon',
  clawEarlybirdExpiresTomorrow: 'Your KiloClaw Earlybird Access Expires Tomorrow',
  clawInstanceReady: 'Your KiloClaw Instance Is Ready',
  // Subjects for scheduled-action notices use admin-provided subject
  // when present (via subjectOverride); these defaults apply when the
  // admin leaves notice_subject blank.
  clawScheduledRestartNotice: 'KiloClaw: Restart Scheduled',
  clawScheduledRestartCancelled: 'KiloClaw: Scheduled Restart Cancelled',
  clawScheduledVersionChangeNotice: 'KiloClaw: Upgrade Scheduled',
  clawScheduledVersionChangeCancelled: 'KiloClaw: Scheduled Upgrade Cancelled',
  clawCreditRenewalFailed: 'Action Required: KiloClaw Hosting Renewal Failed',
  clawComplementaryInferenceEnded: 'Your Free AI Inference Period Has Ended',
  accountDeletionRequest: 'Kilo: Account Deletion Request Received',
  accountDeletionCompleted: 'Kilo: Account deletion complete',
  creditsTopUp: 'Your Kilo credit top-up',
  kiloClawSubscriptionStarted: 'Your KiloClaw subscription is active',
  kiloPassDuplicateCardCanceled: 'Kilo Pass: Subscription Cancelled',
  securityFindingNew: 'Kilo Security Agent: New finding',
  securityFindingSlaWarning: 'Kilo Security Agent: SLA warning',
  securityFindingSlaBreach: 'Kilo Security Agent: SLA breached',
  recommendationsDigest: 'Kilo: Your weekly recommendations',
  kiloPassOrgBlocked: 'Action required: Update Kilo Pass assignments',
  userDataExportReady: 'Your Kilo data export is ready',
  dataExportDownloadCode: 'Your Kilo data export download code',
  // The sender appends the cutover date; this is the admin preview and test subject.
  autoRoutingPoolNotice: 'Change Required: Your Auto model pool has a new model ID',
} as const;

export type TemplateName = keyof typeof subjects;

export function escapeHtml(str: string): string {
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

export function renderNonAutolinkedText(str: string): RawHtml {
  return new RawHtml(escapeHtml(str).replace(/[/.]/g, '$&&#8203;'));
}

// Both Next.js apps live at apps/<name> and run with their app directory as the
// working directory, locally and on Vercel. Each app's next.config.mjs traces
// these templates into its functions with outputFileTracingIncludes.
const EMAIL_TEMPLATES_DIR = path.join(process.cwd(), '..', '..', 'packages', 'web-shared', 'src');

// Transactional emails carry a light-mode design system with inline colors, so
// clients that transform colors for dark mode would end up with unreadable
// text. Declaring both schemes here plus a matching dark palette lets clients
// that honor prefers-color-scheme render our own dark theme instead.
const EMAIL_DARK_MODE_STYLES = `<meta name="color-scheme" content="light dark" />
<meta name="supported-color-schemes" content="light dark" />
<style>
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  @media (prefers-color-scheme: dark) {
    .kc-page { background-color: #121212 !important; }
    .kc-strong { color: #f2f2f2 !important; }
    .kc-text { color: #e0e0e0 !important; }
    .kc-muted { color: #b3b3b3 !important; }
    .kc-faint { color: #7a7a7a !important; }
    .kc-box { background-color: #1e1e1e !important; border-color: #333333 !important; }
    .kc-divider { border-top-color: #333333 !important; }
    .kc-btn { background-color: #f2f2f2 !important; color: #121212 !important; }
  }
</style>
`;

function injectDarkModeStyles(html: string, name: string): string {
  if (html.includes('</head>')) {
    return html.replace('</head>', `${EMAIL_DARK_MODE_STYLES}</head>`);
  }
  // Some templates are body-only or bare fragments; head content is allowed
  // before the first body node and browsers hoist it into the head.
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(
      /<html[^>]*>/i,
      match => `${match}\n  <head>${EMAIL_DARK_MODE_STYLES}</head>`
    );
  }
  if (html.trim().length === 0) {
    throw new Error(`Email template '${name}' is empty`);
  }
  return `${EMAIL_DARK_MODE_STYLES}${html}`;
}

// Report an unreadable template before any caller can swallow the error; the
// low-balance alert, for one, only logs send failures from after().
function readTemplate(name: string, directory: 'emails' | 'marketing-emails'): string {
  const templatePath = path.join(EMAIL_TEMPLATES_DIR, directory, `${name}.html`);
  try {
    return fs.readFileSync(templatePath, 'utf-8');
  } catch (error) {
    captureException(error, {
      tags: { source: 'email_template', email_template: name },
      extra: { templatePath },
    });
    throw error;
  }
}

export function renderTemplate(
  name: string,
  vars: TemplateVars,
  directory: 'emails' | 'marketing-emails' = 'emails'
): string {
  let html = readTemplate(name, directory);
  if (directory === 'emails') {
    html = injectDarkModeStyles(html, name);
  }
  const templateVars: TemplateVars = { ...vars, support_email: SUPPORT_EMAIL };
  return html.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => {
    if (!(key in templateVars)) {
      throw new Error(`Missing template variable '${key}' in email template '${name}'`);
    }
    const value = templateVars[key];
    return value instanceof RawHtml ? value.html : escapeHtml(value);
  });
}

export function buildCreditsSection(monthlyCreditsUsd: number): RawHtml {
  if (monthlyCreditsUsd <= 0) return new RawHtml('');
  return new RawHtml(
    `<br />• <strong class="kc-strong" style="color: #1a1a1a">$${monthlyCreditsUsd} USD in Kilo credits</strong>, which reset every 30 days`
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
  const verificationRecipient = getEmailVerificationRecipient(params.to);
  if (verificationRecipient) {
    const isSafeToSend = await verifyEmail(verificationRecipient);
    if (!isSafeToSend) {
      return { sent: false, reason: 'neverbounce_rejected' };
    }
  }

  const subject = params.subjectOverride ?? subjects[params.templateName];
  const html = renderTemplate(params.templateName, {
    ...params.templateVars,
    year: String(new Date().getFullYear()),
  });
  const result = await sendViaMailgun({
    to: params.to,
    subject,
    html,
    category: params.templateName,
  });
  if (!result) return { sent: false, reason: 'provider_not_configured' };
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

export async function sendKiloPassOrgBlockedEmail(
  to: string,
  props: { organizationId: string; organizationName: string }
): Promise<SendResult> {
  return send({
    to,
    templateName: 'kiloPassOrgBlocked',
    templateVars: {
      organization_name: props.organizationName,
      manage_url: `${NEXTAUTH_URL}/organizations/${props.organizationId}/subscriptions/kilo-pass`,
    },
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
      organization_name: renderNonAutolinkedText(data.organizationName),
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
      expires_in: '30 minutes',
      expires_at: new Date(magicLink.expires_at).toISOString(),
      app_url: NEXTAUTH_URL,
    },
  });
}

export async function sendSignInCodeEmail(email: string, code: string): Promise<SendResult> {
  return send({
    to: email,
    templateName: 'signInCode',
    templateVars: {
      code,
      email,
      expires_in: `${SIGN_IN_CODE_EXPIRY_MINUTES} minutes`,
    },
  });
}

export async function sendAccountLinkCodeEmail(
  email: string,
  code: string,
  providerName: string
): Promise<SendResult> {
  return send({
    to: email,
    templateName: 'accountLinkCode',
    templateVars: {
      code,
      email,
      provider_name: providerName,
      expires_in: `${SIGN_IN_CODE_EXPIRY_MINUTES} minutes`,
    },
  });
}

/**
 * Who acted and when, as a security notice reports it. The owner's own request
 * names its address, approximate location and browser; an action Kilo support
 * took names support and the time only, never the staff member's request.
 */
export type SecurityNoticeRequest =
  | {
      actor: 'owner';
      occurredAt: Date;
      ip: string | null;
      /** An approximate location from the request's geolocation headers. */
      location: string | null;
      /** The browser and operating system from the user agent. */
      device: string | null;
    }
  | { actor: 'support'; occurredAt: Date };

function securityNoticeDetails(request: SecurityNoticeRequest): RawHtml {
  const time = `Time: ${request.occurredAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  const lines =
    request.actor === 'support'
      ? [time, 'Done by: Kilo support']
      : [
          time,
          `IP address: ${request.ip ?? 'Unknown'}`,
          `Approximate location: ${request.location ?? 'Unknown'}`,
          `Browser: ${request.device ?? 'Unknown'}`,
        ];
  return new RawHtml(lines.map(escapeHtml).join('<br />'));
}

function appPageLink(pagePath: '/connected-accounts' | '/profile'): RawHtml {
  const url = `${NEXTAUTH_URL}${pagePath}`;
  return new RawHtml(
    `<a class="kc-strong" href="${escapeHtml(url)}" style="color: #1a1a1a">${escapeHtml(url)}</a>`
  );
}

/**
 * The variables every security notice shares: who acted and when, and
 * navigational links to the pages its "If this was not you" steps name.
 * Neither link changes anything when opened.
 */
function securityNoticeVars(email: string, request: SecurityNoticeRequest): TemplateVars {
  return {
    email,
    change_details: securityNoticeDetails(request),
    connected_accounts_link: appPageLink('/connected-accounts'),
    profile_link: appPageLink('/profile'),
  };
}

/**
 * The sentences of a notice that either the owner or Kilo support can cause:
 * "if this was you" fits only the owner's own action.
 */
function actorNoticeVars(request: SecurityNoticeRequest): TemplateVars {
  return request.actor === 'support'
    ? { actor_note: 'Kilo support made this change.', not_you_lead: 'If you did not ask for this:' }
    : { actor_note: 'If this was you, no action is needed.', not_you_lead: 'If this was not you:' };
}

/**
 * The first paragraph's addition and the "If this was not you" step of a
 * new sign-in method notice. A link that replaced the account's other sign-in
 * methods names them and the browser sign-out it caused, and points to
 * support: the owner cannot remove the replacing method themselves.
 */
function newSignInMethodReplacementVars(
  replacedMethodNames: readonly [string, ...string[]] | null
): TemplateVars {
  const profileLink = appPageLink('/profile').html;
  const supportEmail = escapeHtml(SUPPORT_EMAIL);
  const resetStep = `reset your API token at ${profileLink}, which signs out every browser, the app, and the CLI`;
  if (replacedMethodNames === null) {
    return {
      replaced_note: '',
      not_you_steps: new RawHtml(
        `remove this sign-in method at ${appPageLink('/connected-accounts').html}, ${resetStep}, and contact ${supportEmail}.`
      ),
    };
  }
  return {
    replaced_note: ` It replaced: ${replacedMethodNames.join(', ')}. Every browser was signed out.`,
    not_you_steps: new RawHtml(
      `contact ${supportEmail} to remove this sign-in method, which you cannot remove yourself, and ${resetStep}.`
    ),
  };
}

/**
 * `replacedMethodNames` are the display names of the sign-in methods the link
 * removed, or null when it removed none.
 */
export async function sendNewSignInMethodEmail(
  email: string,
  providerName: string,
  linkedIdentity: { email: string; displayName?: string | null },
  replacedMethodNames: readonly [string, ...string[]] | null,
  request: SecurityNoticeRequest
): Promise<SendResult> {
  const displayName = linkedIdentity.displayName?.trim();
  return send({
    to: email,
    templateName: 'newSignInMethod',
    templateVars: {
      ...securityNoticeVars(email, request),
      ...newSignInMethodReplacementVars(replacedMethodNames),
      provider_name: providerName,
      linked_identity: displayName
        ? `${displayName} (${linkedIdentity.email})`
        : linkedIdentity.email,
    },
  });
}

export async function sendSignInMethodRemovedEmail(
  email: string,
  providerName: string,
  request: SecurityNoticeRequest
): Promise<SendResult> {
  return send({
    to: email,
    templateName: 'signInMethodRemoved',
    templateVars: { ...securityNoticeVars(email, request), provider_name: providerName },
  });
}

/** A passkey's own name in parentheses after "A passkey", or nothing when it was never named. */
function passkeyNameNote(passkeyName: string | null): RawHtml {
  const name = passkeyName?.trim();
  return new RawHtml(name ? ` (${renderNonAutolinkedText(name).html})` : '');
}

export async function sendPasskeyAddedEmail(
  email: string,
  passkeyName: string | null,
  request: SecurityNoticeRequest
): Promise<SendResult> {
  return send({
    to: email,
    templateName: 'passkeyAdded',
    templateVars: {
      ...securityNoticeVars(email, request),
      passkey_name_note: passkeyNameNote(passkeyName),
    },
  });
}

export async function sendPasskeyRemovedEmail(
  email: string,
  passkeyName: string | null,
  request: SecurityNoticeRequest
): Promise<SendResult> {
  return send({
    to: email,
    templateName: 'passkeyRemoved',
    templateVars: {
      ...securityNoticeVars(email, request),
      passkey_name_note: passkeyNameNote(passkeyName),
    },
  });
}

/**
 * How a device sign-in names the device that asked. A name the requesting
 * device chose for itself is its own words, not Kilo's, so it is always shown
 * quoted and attributed; a recognised client kind or a parsed browser label
 * is Kilo's own description.
 */
export type DeviceSignInRequester =
  | { kind: 'self_named'; name: string }
  | { kind: 'recognised'; label: string }
  | { kind: 'unidentified' };

/** The longest self-chosen device name a notice repeats, in characters. */
const SELF_NAMED_CLIENT_MAX_LENGTH = 40;

/**
 * A name the requesting device chose for itself, cut to a short length and
 * with every double quote mark replaced, so the quotes a notice puts around
 * it cannot be closed early by the name itself.
 */
export function selfNamedClientName(name: string): string {
  const characters = Array.from(replaceQuoteMarks(name.trim()));
  return characters.length > SELF_NAMED_CLIENT_MAX_LENGTH
    ? `${characters.slice(0, SELF_NAMED_CLIENT_MAX_LENGTH).join('').trimEnd()}…`
    : characters.join('');
}

/** A self-chosen device name, quoted so it never reads as Kilo's own words. */
function quotedClientName(name: string): string {
  return `"${selfNamedClientName(name)}"`;
}

function requesterSentenceLabel(requester: DeviceSignInRequester): string {
  switch (requester.kind) {
    case 'self_named':
      return `a device that named itself ${quotedClientName(requester.name)}`;
    case 'recognised':
      return requester.label;
    case 'unidentified':
      return 'an unidentified device';
  }
}

function requesterLineLabel(requester: DeviceSignInRequester): string {
  switch (requester.kind) {
    case 'self_named':
      return `named itself ${quotedClientName(requester.name)}`;
    case 'recognised':
      return requester.label;
    case 'unidentified':
      return 'Unidentified';
  }
}

/**
 * `requester` is the device that asked to sign in, read from its stored
 * request; `request` is where the approval was given, which can be a
 * different place.
 */
export async function sendDeviceSignInApprovedEmail(
  email: string,
  requester: { client: DeviceSignInRequester; ip: string | null },
  request: SecurityNoticeRequest
): Promise<SendResult> {
  return send({
    to: email,
    templateName: 'deviceSignInApproved',
    templateVars: {
      ...securityNoticeVars(email, request),
      client_label: renderNonAutolinkedText(requesterSentenceLabel(requester.client)),
      requesting_device: renderNonAutolinkedText(requesterLineLabel(requester.client)),
      request_ip: requester.ip ?? 'Unknown',
    },
  });
}

/**
 * What an API token reset did. The owner's own reset also signs out every
 * browser and device; a reset by Kilo support stops only the API tokens.
 */
function apiKeyResetEffect(request: SecurityNoticeRequest): string {
  return request.actor === 'support'
    ? 'Every earlier API token stopped working. Browsers and signed-in devices stay signed in.'
    : 'Every earlier token stopped working, and every browser, the app, and the CLI were signed out.';
}

export async function sendApiKeyResetEmail(
  email: string,
  request: SecurityNoticeRequest
): Promise<SendResult> {
  return send({
    to: email,
    templateName: 'apiKeyReset',
    templateVars: {
      ...securityNoticeVars(email, request),
      ...actorNoticeVars(request),
      reset_effect: apiKeyResetEffect(request),
    },
  });
}

export async function sendBrowserSessionsRevokedEmail(
  email: string,
  request: SecurityNoticeRequest
): Promise<SendResult> {
  return send({
    to: email,
    templateName: 'browserSessionsRevoked',
    templateVars: { ...securityNoticeVars(email, request), ...actorNoticeVars(request) },
  });
}

/** `revokedDevice` is Kilo's description of the signed-out device, or null when it has none. */
export async function sendDeviceSessionRevokedEmail(
  email: string,
  revokedDevice: string | null,
  request: SecurityNoticeRequest
): Promise<SendResult> {
  return send({
    to: email,
    templateName: 'deviceSessionRevoked',
    templateVars: {
      ...securityNoticeVars(email, request),
      revoked_device: renderNonAutolinkedText(revokedDevice ?? 'Unidentified'),
    },
  });
}

export async function sendSignInResetBySupportEmail(
  email: string,
  request: SecurityNoticeRequest
): Promise<SendResult> {
  return send({
    to: email,
    templateName: 'signInResetBySupport',
    templateVars: securityNoticeVars(email, request),
  });
}

/** `methodName` is the sign-in method's display name, or null when it is not one this build names. */
export async function sendNewSignInEmail(
  email: string,
  methodName: string | null,
  request: SecurityNoticeRequest
): Promise<SendResult> {
  return send({
    to: email,
    templateName: 'newSignIn',
    templateVars: {
      ...securityNoticeVars(email, request),
      method_name: methodName ?? 'a sign-in method',
    },
  });
}

export async function sendSignInMethodChangeCodeEmail(
  email: string,
  props: { code: string; change: 'link' | 'unlink'; providerName: string; expiresInMinutes: number }
): Promise<SendResult> {
  return send({
    to: email,
    templateName: 'signInMethodChangeCode',
    templateVars: {
      code: props.code,
      email,
      change_action: props.change === 'link' ? 'add' : 'remove',
      provider_name: props.providerName,
      expires_in: `${props.expiresInMinutes} minutes`,
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

export async function sendCodeReviewDisabledEmail(
  to: string,
  props: { reason: string; recoveryUrl: string; recoveryLabel: string }
): Promise<SendResult> {
  return send({
    to,
    templateName: 'codeReviewDisabled',
    templateVars: {
      reason: props.reason,
      recovery_url: props.recoveryUrl,
      recovery_label: props.recoveryLabel,
    },
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

  const sendToRecipient = async (email: string) => {
    const result = await send({
      to: email,
      templateName: 'balanceAlert',
      templateVars: {
        minimum_balance: String(minimum_balance),
        organization_url,
      },
    });
    if (result.sent) {
      logExceptInTest(
        `[sendBalanceAlertEmail] Sent to ${email} for org ${organizationId} (threshold: $${minimum_balance})`
      );
    } else {
      warnExceptInTest(
        `[sendBalanceAlertEmail] Failed to send to ${email} for org ${organizationId}: reason=${result.reason}`
      );
    }
    return result;
  };

  const BATCH_SIZE = 10;
  for (let i = 0; i < to.length; i += BATCH_SIZE) {
    await Promise.all(to.slice(i, i + BATCH_SIZE).map(sendToRecipient));
  }
}

type SendSpendAlertEmailProps = {
  /** Every authorized billing contact of the one scope; one email each. */
  to: string[];
  /** Personal renders the personal usage view; organization its usage details. */
  scopeType: 'personal' | 'organization';
  /** The scope's owner id: the user id for personal, the organization id otherwise. */
  scopeId: string;
  scopeName: string;
  kindLabel: string;
  /** The scope's own rolling spend, in USD. */
  amountUsd: number;
  /** The threshold that spend crossed, in USD. */
  thresholdUsd: number;
};

/**
 * Per-recipient outcome of one alert send, classified so the delivery outbox
 * can tell a permanent rejection from a transient failure. A `neverbounce`
 * rejection or an unconfigured provider never succeeds on a retry, so the row
 * must reach a terminal outcome instead of resending the alert to everyone
 * forever; a thrown provider error is the only retryable case.
 */
export type SpendAlertEmailOutcome = {
  /** Recipients the provider accepted. Never send these again. */
  delivered: string[];
  /** Recipients whose send failed transiently and should be retried. */
  retryable: string[];
  /** Recipients that can never receive this mail (rejected address, no provider). */
  undeliverable: string[];
};

/**
 * One alert email per recipient, carrying only this scope's amount and
 * threshold. The single call to action opens this scope's spend view.
 *
 * Never throws: each recipient's result is classified so the delivery outbox
 * can reschedule only the transient failures, keep a permanent rejection out of
 * the retry loop, and avoid re-emailing a recipient an earlier attempt reached.
 */
export async function sendSpendAlertEmail(
  props: SendSpendAlertEmailProps
): Promise<SpendAlertEmailOutcome> {
  const { to, scopeType, scopeId, scopeName, kindLabel, amountUsd, thresholdUsd } = props;

  const outcome: SpendAlertEmailOutcome = { delivered: [], retryable: [], undeliverable: [] };

  if (!to || to.length === 0) {
    console.warn('[sendSpendAlertEmail] No recipients configured - skipping email');
    return outcome;
  }

  const spend_url =
    scopeType === 'organization'
      ? `${NEXTAUTH_URL}/organizations/${scopeId}/usage-details`
      : `${NEXTAUTH_URL}/usage`;

  const templateVars = {
    spend_url,
    cta_label: 'Open spend view',
    scope_name: scopeName,
    kind_label: kindLabel,
    amount_usd: amountUsd.toFixed(2),
    threshold_usd: thresholdUsd.toFixed(2),
  };

  const sendToRecipient = async (email: string) => {
    try {
      const result = await send({ to: email, templateName: 'spendAlert', templateVars });
      if (result.sent) {
        outcome.delivered.push(email);
        logExceptInTest(`[sendSpendAlertEmail] Sent to ${email} for scope ${scopeId}`);
      } else {
        outcome.undeliverable.push(email);
        warnExceptInTest(
          `[sendSpendAlertEmail] Failed to send to ${email} for scope ${scopeId}: reason=${result.reason}`
        );
      }
    } catch (error) {
      outcome.retryable.push(email);
      warnExceptInTest(
        `[sendSpendAlertEmail] Transport failure for ${email} on scope ${scopeId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  };

  const BATCH_SIZE = 10;
  for (let i = 0; i < to.length; i += BATCH_SIZE) {
    await Promise.all(to.slice(i, i + BATCH_SIZE).map(sendToRecipient));
  }
  return outcome;
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

export async function sendAccountDeletionConfirmationEmail(to: string): Promise<SendResult> {
  return send({
    to,
    templateName: 'accountDeletionRequest',
    templateVars: { email: to },
  });
}

export async function sendAccountDeletionCompletedEmail(to: string): Promise<SendResult> {
  return send({
    to,
    templateName: 'accountDeletionCompleted',
    templateVars: {
      completion_message: new RawHtml(USER_DELETION_COMPLETION_HTML),
    },
  });
}

export async function sendUserDataExportReadyEmail(
  to: string,
  props: { expiresAt: Date }
): Promise<SendResult> {
  return send({
    to,
    templateName: 'userDataExportReady',
    templateVars: {
      data_exports_url: `${NEXTAUTH_URL}/data-exports`,
      expiry_date: formatDate(props.expiresAt),
    },
  });
}

export async function sendDataExportDownloadCodeEmail(
  to: string,
  props: { code: string; expiresInMinutes: number }
): Promise<SendResult> {
  return send({
    to,
    templateName: 'dataExportDownloadCode',
    templateVars: {
      code: props.code,
      email: to,
      expires_in: `${props.expiresInMinutes} minutes`,
    },
  });
}

export async function sendAccountDeletionSupportNotification(
  userEmail: string,
  userId: string
): Promise<void> {
  await sendViaMailgun({
    to: SUPPORT_EMAIL,
    subject: `Account Deletion Request — ${userEmail}`,
    html: `<p>User <strong>${userEmail}</strong> (ID: <code>${userId}</code>) has requested account deletion from the mobile app.</p>`,
    replyTo: userEmail,
    category: 'accountDeletionSupport',
  });
}

const CREDITS_TOPUP_COPY = {
  manual: {
    subject: subjects.creditsTopUp,
    heading: 'Thanks for your top-up',
    intro: () =>
      'Your Kilo credit top-up has been processed and the credits are now available on your account.',
  },
  auto: {
    subject: 'Kilo auto top-up successful',
    heading: 'Your auto top-up was successful',
    intro: () =>
      'Your account was automatically topped up so you can keep using Kilo without interruption. The new credits are available now.',
  },
  org_manual: {
    subject: 'Your Kilo org credit top-up',
    heading: 'Team credits added',
    intro: (organizationName: string) =>
      `A Kilo credit top-up has been processed for ${organizationName}. The credits are now available to the organization.`,
  },
  org_auto: {
    subject: 'Kilo team auto top-up successful',
    heading: 'Team auto top-up was successful',
    intro: (organizationName: string) =>
      `${organizationName} was automatically topped up so your team can keep using Kilo without interruption. The new credits are available now.`,
  },
} as const;

export type CreditsTopUpVariant = keyof typeof CREDITS_TOPUP_COPY;

type BaseSendCreditsTopUpEmailProps = {
  to: string;
  principalCents: number;
  serviceFeeCents: number;
  grossPaidCents: number;
  creditsCents: number;
  purchaseDate: Date;
  creditExpiryDate?: Date | null;
  receiptUrl?: string | null;
};

type PersonalCreditsTopUpEmailProps = BaseSendCreditsTopUpEmailProps & {
  variant: 'manual' | 'auto';
};

type OrganizationCreditsTopUpEmailProps = BaseSendCreditsTopUpEmailProps & {
  variant: 'org_manual' | 'org_auto';
  creditsUrl?: string;
  organizationId?: Organization['id'];
  organizationName?: Organization['name'];
} & ({ creditsUrl: string } | { organizationId: Organization['id'] });

type SendCreditsTopUpEmailProps =
  | PersonalCreditsTopUpEmailProps
  | OrganizationCreditsTopUpEmailProps;

function isOrganizationCreditsTopUpEmail(
  props: SendCreditsTopUpEmailProps
): props is OrganizationCreditsTopUpEmailProps {
  return props.variant === 'org_manual' || props.variant === 'org_auto';
}

export function buildCreditsTopUpReceiptSection(receiptUrl: string | null | undefined): RawHtml {
  if (!receiptUrl) return new RawHtml('');
  const escaped = escapeHtml(receiptUrl);
  return new RawHtml(
    `<a class="kc-strong" href="${escaped}" style="color: #1a1a1a; text-decoration: underline">View your Stripe receipt</a>.`
  );
}

function formatUsd(cents: number): string {
  return (cents / 100).toFixed(2);
}

const TOP_UP_INFO_ROW_STYLE =
  "margin: 0 0 8px; font-size: 13px; line-height: 20px; color: #555; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export function buildCreditsTopUpInfoRow(label: string, value: string): string {
  return `<p class="kc-muted" style="${TOP_UP_INFO_ROW_STYLE}"><strong class="kc-strong" style="color: #1a1a1a">${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>`;
}

// Optional fee + total-paid rows. Fee-free callers get empty HTML so the
// template can keep the Amount/Credits summary with no exemption copy.
export function buildCreditsTopUpServiceFeeSection(params: {
  serviceFeeCents: number;
  grossPaidCents: number;
}): RawHtml {
  if (params.serviceFeeCents <= 0) {
    return new RawHtml('');
  }

  return new RawHtml(
    buildCreditsTopUpInfoRow('Service fee (5%)', `$${formatUsd(params.serviceFeeCents)} USD`) +
      buildCreditsTopUpInfoRow('Total paid', `$${formatUsd(params.grossPaidCents)} USD`)
  );
}

// Fee itemization already labels the granted amount as Credits added, so this
// row is omitted when a fee is charged. Fee-free callers keep Credits.
export function buildCreditsTopUpCreditsRowSection(params: {
  creditsCents: number;
  hasServiceFee: boolean;
}): RawHtml {
  if (params.hasServiceFee) {
    return new RawHtml('');
  }

  return new RawHtml(buildCreditsTopUpInfoRow('Credits', `$${formatUsd(params.creditsCents)} USD`));
}

export function buildCreditsTopUpExpirySection(creditExpiryDate: Date | null | undefined): RawHtml {
  if (creditExpiryDate === undefined) return new RawHtml('');
  if (creditExpiryDate === null) {
    return new RawHtml(
      buildCreditsTopUpInfoRow(
        'Purchased credits',
        'No expiration. Promotional and bonus credits may have their own deadlines.'
      )
    );
  }
  const deadline = creditExpiryDate.toLocaleString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  });
  return new RawHtml(
    buildCreditsTopUpInfoRow(
      'Purchased credits expire',
      `${deadline}. Promotional and bonus credits may have earlier deadlines.`
    )
  );
}

function formatDate(date: Date): string {
  // Dates surfaced to end-users; the server locale is stable (UTC in prod) so
  // explicit en-US formatting avoids surprise month-name changes in tests.
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export async function sendCreditsTopUpEmail(
  props: SendCreditsTopUpEmailProps
): Promise<SendResult> {
  const copy = CREDITS_TOPUP_COPY[props.variant];
  const isOrgVariant = isOrganizationCreditsTopUpEmail(props);

  if (isOrgVariant && !props.creditsUrl && !props.organizationId) {
    throw new Error('Organization top-up emails require creditsUrl or organizationId');
  }

  const organizationName = isOrgVariant ? (props.organizationName ?? 'your organization') : '';
  const credits_url = isOrgVariant
    ? props.creditsUrl || `${NEXTAUTH_URL}/organizations/${props.organizationId}/payment-details`
    : `${NEXTAUTH_URL}/credits`;
  const hasServiceFee = props.serviceFeeCents > 0;
  return send({
    to: props.to,
    templateName: 'creditsTopUp',
    subjectOverride: copy.subject,
    templateVars: {
      heading: copy.heading,
      intro: copy.intro(organizationName),
      amount_label: hasServiceFee ? 'Credits added' : 'Amount',
      amount_usd: formatUsd(props.principalCents),
      service_fee_section: buildCreditsTopUpServiceFeeSection({
        serviceFeeCents: props.serviceFeeCents,
        grossPaidCents: props.grossPaidCents,
      }),
      credits_row_section: buildCreditsTopUpCreditsRowSection({
        creditsCents: props.creditsCents,
        hasServiceFee,
      }),
      purchase_date: formatDate(props.purchaseDate),
      credit_expiry_section: buildCreditsTopUpExpirySection(props.creditExpiryDate),
      credits_url,
      receipt_section: buildCreditsTopUpReceiptSection(props.receiptUrl),
    },
  });
}

type SendKiloClawSubscriptionStartedEmailProps = {
  to: string;
  planName: string;
  priceCents: number;
  billingPeriod: string;
  nextBillingDate: Date;
};

export async function sendKiloClawSubscriptionStartedEmail(
  props: SendKiloClawSubscriptionStartedEmailProps
): Promise<SendResult> {
  const manage_url = `${NEXTAUTH_URL}/claw/subscription`;
  return send({
    to: props.to,
    templateName: 'kiloClawSubscriptionStarted',
    templateVars: {
      plan_name: props.planName,
      price_usd: formatUsd(props.priceCents),
      billing_period: props.billingPeriod,
      next_billing_date: formatDate(props.nextBillingDate),
      manage_url,
    },
  });
}

export async function sendKiloPassDuplicateCardCanceledEmail(
  to: string,
  props: { supportUrl?: string }
): Promise<SendResult> {
  const support_url = props.supportUrl ?? `mailto:${SUPPORT_EMAIL}`;
  return send({
    to,
    templateName: 'kiloPassDuplicateCardCanceled',
    templateVars: { support_url },
  });
}

type RecommendationsDigestRecommendation = {
  title: string;
  description: string;
  actionLabel: string;
  // Relative path (e.g. /organizations/<id>/integrations); prefixed with the app URL.
  actionUrl: string;
};

type SendRecommendationsDigestEmailProps = {
  organizationId: string;
  organizationName: string;
  adoptedCount: number;
  totalCount: number;
  openCount: number;
  recommendations: RecommendationsDigestRecommendation[];
};

function buildRecommendationsDigestSection(
  recommendations: RecommendationsDigestRecommendation[],
  baseUrl: string
): RawHtml {
  const rows = recommendations
    .map(rec => {
      const href = `${baseUrl}${escapeHtml(rec.actionUrl)}`;
      return `
        <tr>
          <td class="kc-divider" style="padding: 14px 0; border-top: 1px solid #ebebea">
            <p class="kc-strong" style="margin: 0 0 4px; font-size: 14px; font-weight: 600; color: #1a1a1a">${escapeHtml(
              rec.title
            )}</p>
            <p class="kc-muted" style="margin: 0 0 8px; font-size: 13px; line-height: 18px; color: #555">${escapeHtml(
              rec.description
            )}</p>
            <a class="kc-strong" href="${href}" style="font-size: 13px; color: #1a1a1a; text-decoration: underline">${escapeHtml(
              rec.actionLabel
            )}</a>
          </td>
        </tr>`;
    })
    .join('');
  return new RawHtml(
    `<table width="100%" cellpadding="0" cellspacing="0" style="margin: 0 0 8px">${rows}</table>`
  );
}

export async function sendRecommendationsDigestEmail(
  to: string,
  props: SendRecommendationsDigestEmailProps
): Promise<SendResult> {
  const dashboard_url = `${NEXTAUTH_URL}/organizations/${props.organizationId}/usage-details?view=feature-adoption`;
  return send({
    to,
    templateName: 'recommendationsDigest',
    templateVars: {
      organization_name: renderNonAutolinkedText(props.organizationName),
      adopted_summary: `${props.adoptedCount} of ${props.totalCount}`,
      open_count: String(props.openCount),
      recommendations_section: buildRecommendationsDigestSection(
        props.recommendations,
        NEXTAUTH_URL
      ),
      dashboard_url,
    },
  });
}
