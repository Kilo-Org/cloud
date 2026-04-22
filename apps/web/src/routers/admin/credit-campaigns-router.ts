import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import {
  credit_campaigns,
  credit_transactions,
  kilocode_users,
  type CreditCampaign,
} from '@kilocode/db/schema';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { and, count, desc, eq } from 'drizzle-orm';
import {
  CREDIT_CAMPAIGN_SLUG_FORMAT,
  credit_categoryForSlug,
  getCampaignStats,
  isCreditCategoryCollision,
} from '@/lib/credit-campaigns';

/**
 * Shared input schema for create/update. Matches the form on the admin
 * UI (which imports these schemas via `z.infer`) so client + server
 * validation can't drift. Money is transported as dollars to match the
 * admin-facing mental model; we convert to microdollars at the
 * storage boundary.
 */
const campaignInputShape = {
  slug: z
    .string()
    .regex(CREDIT_CAMPAIGN_SLUG_FORMAT, 'Slug must be 5-40 lowercase alphanumerics or hyphens'),
  amount_usd: z.number().min(0.01).max(1000),
  credit_expiry_hours: z.number().int().positive().max(87_600).nullable().optional(),
  campaign_ends_at: z
    .string()
    .datetime({ offset: true })
    .nullable()
    .optional()
    .refine(v => v == null || new Date(v).getTime() > Date.now(), {
      message: 'Campaign end date must be in the future',
    })
    .transform(v => v ?? null),
  total_redemptions_allowed: z.number().int().positive().max(1_000_000),
  active: z.boolean().default(true),
  description: z
    .string()
    .min(1)
    .max(1000)
    .refine(v => v.trim().length > 0, 'Notes cannot be empty or whitespace-only'),
};

export const createCampaignInputSchema = z.object(campaignInputShape);

/**
 * Update schema omits `slug` (and therefore `credit_category`) because a
 * campaign's category is written into `credit_transactions` at grant time.
 * Changing it after redemptions exist orphans those rows from the cap
 * counter and the admin stats, which would allow over-granting and hide
 * real spend. We make slug immutable rather than trying to migrate
 * historical `credit_transactions` rows to a new category.
 *
 * Also drops the future-only refine on `campaign_ends_at` — on update the
 * current value may already be in the past (a naturally-expired campaign)
 * and blocking edits would force admins to clear the date before touching
 * anything else.
 */
const campaignUpdateShape = {
  amount_usd: campaignInputShape.amount_usd,
  credit_expiry_hours: campaignInputShape.credit_expiry_hours,
  campaign_ends_at: z
    .string()
    .datetime({ offset: true })
    .nullable()
    .optional()
    .transform(v => v ?? null),
  total_redemptions_allowed: campaignInputShape.total_redemptions_allowed,
  active: campaignInputShape.active,
  description: campaignInputShape.description,
};

export const updateCampaignInputSchema = z.object({
  id: z.number().int().positive(),
  ...campaignUpdateShape,
});

export type CreateCampaignInput = z.infer<typeof createCampaignInputSchema>;
export type UpdateCampaignInput = z.infer<typeof updateCampaignInputSchema>;

export type CampaignWithStats = CreditCampaign & {
  redemption_count: number;
  total_dollars: number;
  last_redemption_at: string | null;
};

function toMicrodollars(amount_usd: number): number {
  return Math.round(amount_usd * 1_000_000);
}

/**
 * Detects a Postgres unique-constraint violation (code 23505). Drizzle
 * wraps the pg error in a DrizzleQueryError so the code lives on the
 * `.cause`; we also check the top-level error in case wrapping changes
 * in a future upgrade.
 */
function isUniqueViolation(error: unknown): boolean {
  const pgCodeFrom = (e: unknown): string | undefined =>
    e && typeof e === 'object' && 'code' in e
      ? ((e as { code?: unknown }).code as string | undefined)
      : undefined;
  if (pgCodeFrom(error) === '23505') return true;
  const cause =
    error && typeof error === 'object' && 'cause' in error
      ? (error as { cause?: unknown }).cause
      : undefined;
  if (pgCodeFrom(cause) === '23505') return true;
  return false;
}

export const creditCampaignsRouter = createTRPCRouter({
  /**
   * List all campaigns alongside per-campaign stats. Stats query is
   * scoped to the known campaign credit_categories (IN-list) so it
   * stays fast even as credit_transactions grows — the slow firehose
   * on /admin/credit-categories groups the whole table, which this
   * view intentionally avoids.
   */
  list: adminProcedure.query(async (): Promise<CampaignWithStats[]> => {
    const campaigns = await db
      .select()
      .from(credit_campaigns)
      .orderBy(desc(credit_campaigns.created_at));

    const categories = campaigns.map(c => c.credit_category);
    const stats = await getCampaignStats(categories);

    return campaigns.map(c => {
      const s = stats.get(c.credit_category);
      return {
        ...c,
        redemption_count: s?.redemption_count ?? 0,
        total_dollars: s?.total_dollars ?? 0,
        last_redemption_at: s?.last_redemption_at ?? null,
      };
    });
  }),

  /**
   * Single-campaign lookup for the edit view.
   */
  get: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ input }): Promise<CreditCampaign> => {
      const rows = await db
        .select()
        .from(credit_campaigns)
        .where(eq(credit_campaigns.id, input.id))
        .limit(1);
      const row = rows[0];
      if (!row) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Campaign not found' });
      }
      return row;
    }),

  create: adminProcedure
    .input(createCampaignInputSchema)
    .mutation(async ({ input, ctx }): Promise<CreditCampaign> => {
      const credit_category = credit_categoryForSlug(input.slug);

      // Keep the DB-managed and TS-defined category namespaces
      // disjoint. A collision here would mean existing TS-driven grant
      // paths and our new DB-driven path both fire on the same
      // `credit_category`, which the per-user unique index is not
      // designed to arbitrate.
      if (await isCreditCategoryCollision(credit_category)) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: `Slug collides with an existing built-in category: ${credit_category}`,
        });
      }

      try {
        const [row] = await db
          .insert(credit_campaigns)
          .values({
            slug: input.slug,
            credit_category,
            amount_microdollars: toMicrodollars(input.amount_usd),
            credit_expiry_hours: input.credit_expiry_hours ?? null,
            campaign_ends_at: input.campaign_ends_at ?? null,
            total_redemptions_allowed: input.total_redemptions_allowed,
            active: input.active,
            description: input.description,
            created_by_kilo_user_id: ctx.user.id,
          })
          .returning();
        return row;
      } catch (error) {
        // Drizzle wraps the pg error in a `DrizzleQueryError`; the
        // original pg error (with code 23505 for unique violations)
        // lives on the `.cause` property. Check both the wrapper and
        // the cause.
        if (isUniqueViolation(error)) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'A campaign with this slug already exists',
          });
        }
        throw error;
      }
    }),

  update: adminProcedure
    .input(updateCampaignInputSchema)
    .mutation(async ({ input }): Promise<CreditCampaign> => {
      // slug + credit_category are deliberately excluded from the SET —
      // they're immutable after create to keep historical credit_transactions
      // rows tied to a stable category. See updateCampaignInputSchema.
      //
      // Atomic guard-then-act: the WHERE clause restricts the update to the
      // single targeted row; the RETURNING clause gives us the authoritative
      // post-update state. A missing row means the campaign was deleted
      // concurrently — treat as NOT_FOUND rather than silently inserting.
      const [row] = await db
        .update(credit_campaigns)
        .set({
          amount_microdollars: toMicrodollars(input.amount_usd),
          credit_expiry_hours: input.credit_expiry_hours ?? null,
          campaign_ends_at: input.campaign_ends_at ?? null,
          total_redemptions_allowed: input.total_redemptions_allowed,
          active: input.active,
          description: input.description,
          updated_at: new Date().toISOString(),
        })
        .where(eq(credit_campaigns.id, input.id))
        .returning();
      if (!row) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Campaign not found' });
      }
      return row;
    }),

  setActive: adminProcedure
    .input(z.object({ id: z.number().int().positive(), active: z.boolean() }))
    .mutation(async ({ input }): Promise<CreditCampaign> => {
      const [row] = await db
        .update(credit_campaigns)
        .set({ active: input.active, updated_at: new Date().toISOString() })
        .where(eq(credit_campaigns.id, input.id))
        .returning();
      if (!row) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Campaign not found' });
      }
      return row;
    }),

  /**
   * Paginated list of users who redeemed a specific campaign. Scoped
   * to the campaign's `credit_category` so the query uses the existing
   * index on `credit_transactions(credit_category)`.
   */
  getRedemptions: adminProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      })
    )
    .query(async ({ input }) => {
      const [campaign] = await db
        .select({ credit_category: credit_campaigns.credit_category })
        .from(credit_campaigns)
        .where(eq(credit_campaigns.id, input.id))
        .limit(1);
      if (!campaign) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Campaign not found' });
      }

      // Only expose fields the admin UI renders. Email is included
      // intentionally (admins need a way to identify who redeemed);
      // no full user row — minimal API responses rule.
      const rows = await db
        .select({
          transaction_id: credit_transactions.id,
          kilo_user_id: credit_transactions.kilo_user_id,
          user_email: kilocode_users.google_user_email,
          amount_microdollars: credit_transactions.amount_microdollars,
          created_at: credit_transactions.created_at,
          expiry_date: credit_transactions.expiry_date,
        })
        .from(credit_transactions)
        .innerJoin(kilocode_users, eq(credit_transactions.kilo_user_id, kilocode_users.id))
        .where(
          and(
            eq(credit_transactions.credit_category, campaign.credit_category),
            // Exclude expiration "negative transaction" rows that share
            // the same credit_category but represent a debit, not a
            // user-facing redemption. The original row is what admins
            // expect to see in the redemption list.
            eq(credit_transactions.is_free, true)
          )
        )
        .orderBy(desc(credit_transactions.created_at))
        .limit(input.limit)
        .offset(input.offset);

      // Return `total` alongside `rows` so the UI can render page
      // navigation ("showing X of Y") without a second round-trip. A
      // separate COUNT(*) query is cleaner than a window function here:
      // the index scan is identical and drizzle's type inference stays
      // simple.
      const [totalRow] = await db
        .select({ n: count() })
        .from(credit_transactions)
        .where(
          and(
            eq(credit_transactions.credit_category, campaign.credit_category),
            eq(credit_transactions.is_free, true)
          )
        );

      return { rows, total: totalRow?.n ?? 0 };
    }),
});
