import { TRPCError } from '@trpc/server';
import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { NEXTAUTH_URL } from '@/lib/config.server';
import { sendViaMailgun } from '@/lib/email-mailgun';
import { verifyEmail } from '@/lib/email-neverbounce';
import {
  subjects,
  creditsVars,
  buildCreditsTopUpReceiptSection,
  RawHtml,
  renderTemplate,
  type TemplateName,
} from '@/lib/email';
import * as z from 'zod';
import { format } from 'date-fns';

const templateNames = Object.keys(subjects) as [TemplateName, ...TemplateName[]];

const TemplateNameSchema = z.enum(templateNames);

function fixtureTemplateVars(template: TemplateName): Record<string, string | RawHtml> {
  const formatDate = (d: Date) => format(d, 'MMMM d, yyyy');
  const orgId = 'fixture-org-id';
  const organization_url = `${NEXTAUTH_URL}/organizations/${orgId}`;
  const invoices_url = `${NEXTAUTH_URL}/organizations/${orgId}/payment-details`;
  const organization_billing_url = invoices_url;
  const organization_claw_url = `${NEXTAUTH_URL}/organizations/${orgId}/claw`;
  const integrations_url = `${NEXTAUTH_URL}/organizations/${orgId}/integrations`;
  const code_reviews_url = `${NEXTAUTH_URL}/organizations/${orgId}/code-reviews`;

  switch (template) {
    case 'orgSubscription':
      return { seats: '5 seats', organization_url, invoices_url };
    case 'orgRenewed':
      return { seats: '5 seats', invoices_url };
    case 'orgCancelled':
      return { invoices_url };
    case 'orgSSOUserJoined':
      return { new_user_email: 'newuser@example.com', organization_url };
    case 'orgInvitation':
      return {
        organization_name: 'Acme Corp',
        inviter_name: 'Alice Smith',
        // fixture URL — non-functional by design (no real token in DB)
        accept_invite_url: `${NEXTAUTH_URL}/users/accept-invite/fixture-code`,
      };
    case 'magicLink':
      return {
        // fixture URL — non-functional by design (no real token in DB)
        magic_link_url: `${NEXTAUTH_URL}/auth/magic?token=fixture-token`,
        email: 'user@example.com',
        expires_in: '24 hours',
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        app_url: NEXTAUTH_URL,
      };
    case 'balanceAlert':
      return { minimum_balance: '10', organization_url };
    case 'autoTopUpFailed':
      return { reason: 'Card declined', credits_url: `${NEXTAUTH_URL}/credits?show-auto-top-up` };
    case 'ossInviteNewUser':
      return {
        organization_name: 'Acme OSS',
        // fixture URL — non-functional by design (no real token in DB)
        accept_invite_url: `${NEXTAUTH_URL}/users/accept-invite/fixture-oss-code`,
        integrations_url,
        code_reviews_url,
        tier_name: 'Premier',
        seats: '25',
        seat_value: '48,000',
        ...creditsVars(500),
      };
    case 'ossInviteExistingUser':
    case 'ossExistingOrgProvisioned':
      return {
        organization_name: 'Acme OSS',
        organization_url,
        integrations_url,
        code_reviews_url,
        tier_name: 'Premier',
        seats: '25',
        seat_value: '48,000',
        ...creditsVars(500),
      };
    case 'deployFailed':
      return {
        deployment_name: 'my-app',
        deployment_url: `${NEXTAUTH_URL}/deployments/fixture-id`,
        repository: 'acme/my-app',
      };
    case 'clawTrialEndingSoon':
      return { days_remaining: '5', claw_url: `${NEXTAUTH_URL}/claw` };
    case 'clawTrialExpiresTomorrow':
    case 'clawInstanceReady':
    case 'clawInstanceDestroyed':
      return { claw_url: `${NEXTAUTH_URL}/claw` };
    case 'clawScheduledRestartNotice':
    case 'clawScheduledRestartCancelled':
      return {
        user_first_name: 'Alice',
        instance_name: 'Research Claw',
        scheduled_at_display: 'Sep 26, 2026, 4:30 PM UTC',
        admin_message_section: new RawHtml(
          '<p style="background-color: #f5f5f5; padding: 12px 16px; border-radius: 6px; font-style: italic">We are applying routine maintenance.</p>'
        ),
      };
    case 'clawScheduledVersionChangeNotice':
    case 'clawScheduledVersionChangeCancelled':
      return {
        user_first_name: 'Alice',
        instance_name: 'Research Claw',
        scheduled_at_display: 'Sep 26, 2026, 4:30 PM UTC',
        admin_message_section: new RawHtml(
          '<p style="background-color: #f5f5f5; padding: 12px 16px; border-radius: 6px; font-style: italic">We are applying routine maintenance.</p>'
        ),
        version_change_section:
          'Upgrading from v1.2.3 (OpenClaw 0.9.0) to v1.2.4 (OpenClaw 0.9.1).',
      };
    case 'clawSuspendedTrial':
    case 'clawSuspendedSubscription':
    case 'clawSuspendedPayment':
      return {
        destruction_date: formatDate(new Date(Date.now() + 7 * 86_400_000)),
        claw_url: `${NEXTAUTH_URL}/claw`,
      };
    case 'clawDestructionWarning':
      return {
        destruction_date: formatDate(new Date(Date.now() + 2 * 86_400_000)),
        claw_url: `${NEXTAUTH_URL}/claw`,
        instance_label: 'Research Claw',
        instance_id_short: '11111111',
      };
    case 'clawOrganizationTrialSuspendedBillingAuthority':
      return {
        organization_name: 'Acme Corp',
        instance_label: 'Research Claw',
        destruction_date: formatDate(new Date(Date.now() + 7 * 86_400_000)),
        organization_billing_url,
      };
    case 'clawOrganizationTrialSuspendedUser':
      return {
        organization_name: 'Acme Corp',
        instance_label: 'Research Claw',
        destruction_date: formatDate(new Date(Date.now() + 7 * 86_400_000)),
        organization_claw_url,
      };
    case 'clawOrganizationDestructionWarningBillingAuthority':
      return {
        organization_name: 'Acme Corp',
        instance_label: 'Research Claw',
        destruction_date: formatDate(new Date(Date.now() + 2 * 86_400_000)),
        organization_billing_url,
      };
    case 'clawOrganizationDestructionWarningUser':
      return {
        organization_name: 'Acme Corp',
        instance_label: 'Research Claw',
        destruction_date: formatDate(new Date(Date.now() + 2 * 86_400_000)),
        organization_claw_url,
      };
    case 'clawOrganizationInstanceDestroyedBillingAuthority':
      return {
        organization_name: 'Acme Corp',
        instance_label: 'Research Claw',
        organization_billing_url,
      };
    case 'clawOrganizationInstanceDestroyedUser':
      return {
        organization_name: 'Acme Corp',
        instance_label: 'Research Claw',
        organization_claw_url,
      };
    case 'clawEarlybirdEndingSoon':
      return { days_remaining: '14', expiry_date: '2026-09-26', claw_url: `${NEXTAUTH_URL}/claw` };
    case 'clawEarlybirdExpiresTomorrow':
      return { expiry_date: '2026-09-26', claw_url: `${NEXTAUTH_URL}/claw` };
    case 'clawCreditRenewalFailed':
      return { claw_url: `${NEXTAUTH_URL}/claw` };
    case 'clawComplementaryInferenceEnded':
      return { claw_url: `${NEXTAUTH_URL}/claw` };
    case 'accountDeletionRequest':
      return { email: 'user@example.com' };
    case 'creditsTopUp':
      return {
        heading: 'Thanks for your top-up',
        intro:
          'Your Kilo credit top-up has been processed and the credits are now available on your account.',
        amount_usd: '10.00',
        credits_usd: '10.00',
        purchase_date: formatDate(new Date()),
        credits_url: `${NEXTAUTH_URL}/credits`,
        receipt_section: buildCreditsTopUpReceiptSection('https://pay.stripe.com/receipts/test'),
      };
    case 'kiloClawSubscriptionStarted':
      return {
        plan_name: 'KiloClaw Standard',
        price_usd: '55.00',
        billing_period: 'May 1, 2026 - June 1, 2026',
        next_billing_date: formatDate(new Date(Date.now() + 30 * 86_400_000)),
        manage_url: `${NEXTAUTH_URL}/claw/subscription`,
      };
  }
  throw new Error(`Unknown template: ${template}`);
}

export const emailTestingRouter = createTRPCRouter({
  getTemplates: adminProcedure.query(() => {
    return templateNames.map(name => ({ name, subject: subjects[name] }));
  }),

  getPreview: adminProcedure
    .input(z.object({ template: TemplateNameSchema }))
    .query(({ input }) => {
      const vars = fixtureTemplateVars(input.template);
      return {
        subject: subjects[input.template],
        html: renderTemplate(input.template, { ...vars, year: String(new Date().getFullYear()) }),
      };
    }),

  sendTest: adminProcedure
    .input(
      z.object({
        template: TemplateNameSchema,
        recipient: z.string().email(),
      })
    )
    .mutation(async ({ input }) => {
      const isSafeToSend = await verifyEmail(input.recipient);
      if (!isSafeToSend) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            'Email blocked by NeverBounce verification. This address is invalid or disposable.',
        });
      }

      const vars = fixtureTemplateVars(input.template);
      const subject = subjects[input.template];
      const html = renderTemplate(input.template, {
        ...vars,
        year: String(new Date().getFullYear()),
      });
      const result = await sendViaMailgun({ to: input.recipient, subject, html });
      if (!result) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'MAILGUN_API_KEY/MAILGUN_DOMAIN is not configured — email was not sent',
        });
      }
      return { recipient: input.recipient };
    }),
});
