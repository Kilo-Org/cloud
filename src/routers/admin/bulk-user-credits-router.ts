import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@/db/schema';
import type { User } from '@/db/schema';
import * as z from 'zod';
import { inArray } from 'drizzle-orm';
import { grantCreditForCategory } from '@/lib/promotionalCredits';

const BulkUserCreditsInputSchema = z.object({
  emails: z.array(z.string().email()),
  amountUsd: z.number().positive(),
  expirationDate: z.string().optional(),
  description: z.string().optional(),
});

type MatchedUser = {
  email: string;
  userId: string;
  userName: string | null;
};

type UnmatchedEmail = {
  email: string;
};

type MatchUsersResult = {
  matched: MatchedUser[];
  unmatched: UnmatchedEmail[];
};

type BulkCreditResult = {
  email: string;
  userId: string;
  success: boolean;
  error?: string;
};

export const bulkUserCreditsRouter = createTRPCRouter({
  /**
   * Match a list of emails to existing Kilo user accounts.
   * Returns matched users and unmatched emails.
   */
  matchUsers: adminProcedure
    .input(z.object({ emails: z.array(z.string().email()) }))
    .mutation(async ({ input }): Promise<MatchUsersResult> => {
      const { emails } = input;

      if (emails.length === 0) {
        return { matched: [], unmatched: [] };
      }

      // Normalize emails to lowercase for matching
      const normalizedEmails = emails.map(e => e.toLowerCase());

      // Find all users with matching emails
      const users = await db
        .select({
          id: kilocode_users.id,
          email: kilocode_users.google_user_email,
          name: kilocode_users.google_user_name,
        })
        .from(kilocode_users)
        .where(inArray(kilocode_users.google_user_email, normalizedEmails));

      // Create a map of email -> user for quick lookup
      const usersByEmail = new Map(users.map(u => [u.email.toLowerCase(), u]));

      const matched: MatchedUser[] = [];
      const unmatched: UnmatchedEmail[] = [];

      for (const email of normalizedEmails) {
        const user = usersByEmail.get(email);
        if (user) {
          matched.push({
            email: user.email,
            userId: user.id,
            userName: user.name,
          });
        } else {
          unmatched.push({ email });
        }
      }

      return { matched, unmatched };
    }),

  /**
   * Grant credits to multiple users at once.
   * Uses the standard credit granting function for each user.
   */
  grantBulkCredits: adminProcedure
    .input(BulkUserCreditsInputSchema)
    .mutation(async ({ input, ctx }): Promise<BulkCreditResult[]> => {
      const { emails, amountUsd, expirationDate, description } = input;
      const results: BulkCreditResult[] = [];

      // Normalize emails
      const normalizedEmails = emails.map(e => e.toLowerCase());

      // Fetch all users at once
      const users = await db
        .select()
        .from(kilocode_users)
        .where(inArray(kilocode_users.google_user_email, normalizedEmails));

      const usersByEmail = new Map(users.map(u => [u.google_user_email.toLowerCase(), u]));

      // Process each email
      for (const email of normalizedEmails) {
        const user = usersByEmail.get(email);

        if (!user) {
          results.push({
            email,
            userId: '',
            success: false,
            error: 'User not found',
          });
          continue;
        }

        if (user.blocked_reason) {
          results.push({
            email,
            userId: user.id,
            success: false,
            error: 'User is blocked',
          });
          continue;
        }

        try {
          const creditResult = await grantCreditForCategory(user as User, {
            credit_category: 'admin-bulk-grant',
            counts_as_selfservice: false,
            amount_usd: amountUsd,
            description:
              description ||
              `Bulk credit grant by ${ctx.user.google_user_name || ctx.user.google_user_email}`,
            credit_expiry_date: expirationDate ? new Date(expirationDate) : undefined,
          });

          if (creditResult.success) {
            results.push({
              email,
              userId: user.id,
              success: true,
            });
          } else {
            results.push({
              email,
              userId: user.id,
              success: false,
              error: creditResult.message,
            });
          }
        } catch (error) {
          results.push({
            email,
            userId: user.id,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      return results;
    }),
});
