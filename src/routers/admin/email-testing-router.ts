import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { NEXTAUTH_URL } from '@/lib/config.server';
import { sendViaCustomerIo } from '@/lib/email-customerio';
import { sendViaMailgun } from '@/lib/email-mailgun';
import { renderTemplate, buildCreditsSection } from '@/lib/email';
import * as z from 'zod';

const templateNames = [
  'orgSubscription',
  'orgRenewed',
  'orgCancelled',
  'orgSSOUserJoined',
  'orgInvitation',
  'magicLink',
  'balanceAlert',
  'autoTopUpFailed',
  'ossInviteNewUser',
  'ossInviteExistingUser',
  'ossExistingOrgProvisioned',
  'deployFailed',
] as const;

type TemplateName = (typeof templateNames)[number];

const TemplateNameSchema = z.enum(templateNames);

const providerNames = ['customerio', 'mailgun'] as const;

type ProviderName = (typeof providerNames)[number];

const ProviderNameSchema = z.enum(providerNames);

const subjects: Record<TemplateName, string> = {
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
};

const year = String(new Date().getFullYear());

function fixtureTemplateVars(template: TemplateName): Record<string, string> {
  const orgId = 'fixture-org-id';
  const organization_url = `${NEXTAUTH_URL}/organizations/${orgId}`;
  const invoices_url = `${NEXTAUTH_URL}/organizations/${orgId}/payment-details`;
  const integrations_url = `${NEXTAUTH_URL}/organizations/${orgId}/integrations`;
  const code_reviews_url = `${NEXTAUTH_URL}/organizations/${orgId}/code-reviews`;

  switch (template) {
    case 'orgSubscription':
      return { seats: '5 seats', organization_url, invoices_url, year };
    case 'orgRenewed':
      return { seats: '5 seats', invoices_url, year };
    case 'orgCancelled':
      return { invoices_url, year };
    case 'orgSSOUserJoined':
      return { new_user_email: 'newuser@example.com', organization_url, year };
    case 'orgInvitation':
      return {
        organization_name: 'Acme Corp',
        inviter_name: 'Alice Smith',
        accept_invite_url: `${NEXTAUTH_URL}/invite/fixture-code`,
        year,
      };
    case 'magicLink':
      return {
        magic_link_url: `${NEXTAUTH_URL}/auth/magic?token=fixture-token`,
        email: 'user@example.com',
        expires_in: '24 hours',
        year,
      };
    case 'balanceAlert':
      return { minimum_balance: '10', organization_url, year };
    case 'autoTopUpFailed':
      return {
        reason: 'Card declined',
        credits_url: `${NEXTAUTH_URL}/credits?show-auto-top-up`,
        year,
      };
    case 'ossInviteNewUser':
      return {
        tier_name: 'Premier',
        seats: '25',
        seat_value: '48,000',
        credits_section: buildCreditsSection(500),
        accept_invite_url: `${NEXTAUTH_URL}/invite/fixture-oss-code`,
        integrations_url,
        code_reviews_url,
        year,
      };
    case 'ossInviteExistingUser':
      return {
        tier_name: 'Premier',
        seats: '25',
        seat_value: '48,000',
        credits_section: buildCreditsSection(500),
        organization_url,
        integrations_url,
        code_reviews_url,
        year,
      };
    case 'ossExistingOrgProvisioned':
      return {
        tier_name: 'Premier',
        seats: '25',
        seat_value: '48,000',
        credits_section: buildCreditsSection(500),
        organization_url,
        integrations_url,
        code_reviews_url,
        year,
      };
    case 'deployFailed':
      return {
        deployment_name: 'my-app',
        deployment_url: `${NEXTAUTH_URL}/deployments/fixture-id`,
        repository: 'acme/my-app',
        year,
      };
  }
}

export const emailTestingRouter = createTRPCRouter({
  getTemplates: adminProcedure.query(() => {
    return templateNames.map(name => ({ name, subject: subjects[name] }));
  }),

  getProviders: adminProcedure.query((): ProviderName[] => {
    return [...providerNames];
  }),

  getPreview: adminProcedure
    .input(z.object({ template: TemplateNameSchema, provider: ProviderNameSchema }))
    .query(({ input }) => {
      const vars = fixtureTemplateVars(input.template);
      const subject = subjects[input.template];

      if (input.provider === 'mailgun') {
        const html = renderTemplate(input.template, vars);
        return { type: 'mailgun' as const, subject, html };
      }

      // customerio: show the template variables as key/value pairs
      return { type: 'customerio' as const, subject, message_data: vars };
    }),

  sendTest: adminProcedure
    .input(
      z.object({
        template: TemplateNameSchema,
        provider: ProviderNameSchema,
        recipient: z.string().email(),
      })
    )
    .mutation(async ({ input }) => {
      const vars = fixtureTemplateVars(input.template);
      const subject = subjects[input.template];
      const html = renderTemplate(input.template, vars);

      if (input.provider === 'mailgun') {
        await sendViaMailgun({ to: input.recipient, subject, html });
      } else {
        await sendViaCustomerIo({ to: input.recipient, subject, html });
      }

      return { success: true, provider: input.provider, recipient: input.recipient };
    }),
});
