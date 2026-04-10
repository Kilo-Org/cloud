import { TRPCError } from '@trpc/server';
import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { NEXTAUTH_URL } from '@/lib/config.server';
import { sendViaMailgun } from '@/lib/email-mailgun';
import { verifyEmail } from '@/lib/email-neverbounce';
import {
  subjects,
  creditsVars,
  renderTemplate,
  type RawHtml,
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
      };
    case 'clawEarlybirdEndingSoon':
      return { days_remaining: '14', expiry_date: '2026-09-26', claw_url: `${NEXTAUTH_URL}/claw` };
    case 'clawEarlybirdExpiresTomorrow':
      return { expiry_date: '2026-09-26', claw_url: `${NEXTAUTH_URL}/claw` };
    case 'clawCreditRenewalFailed':
      return { claw_url: `${NEXTAUTH_URL}/claw` };
    case 'clawComplementaryInferenceEnded':
      return {
        claw_url: `${NEXTAUTH_URL}/claw`,
        credits_url: `${NEXTAUTH_URL}/credits`,
        free_model_name: 'Kilo Auto Free',
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
