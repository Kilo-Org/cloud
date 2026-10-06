import { randomUUID } from 'node:crypto';
import { query } from '@support/core/db';

/** Marks users created by the dev-only fake-login provider (apps/web/src/lib/auth/constants.ts). */
const FAKE_LOGIN_HOSTED_DOMAIN = '@@fake@@';

export type SeededUser = { id: string; email: string; name: string };

type UserOptions = {
  /** Readable prefix for the generated id and email, e.g. `app-shell`. */
  prefix?: string;
  isAdmin?: boolean;
};

/**
 * Creates the rows a test needs directly in the database, so every test owns its data and never
 * depends on shared dev records. Ids and emails are unique per call.
 */
export class SeedData {
  /** A validated user (skips the Stytch check and the customer-source survey). */
  async user(options: UserOptions = {}): Promise<SeededUser> {
    const { prefix = 'e2e', isAdmin = false } = options;
    const uniqueId = randomUUID().slice(0, 8);
    const user = {
      id: `${prefix}-${uniqueId}`,
      email: `${prefix}-${uniqueId}@${isAdmin ? 'admin.example.com' : 'example.com'}`,
      name: `${prefix} ${uniqueId}`,
    };
    await query(
      `insert into kilocode_users (id, google_user_email, google_user_name, google_user_image_url, hosted_domain,
         stripe_customer_id, completed_welcome_form, customer_source, has_validation_stytch, is_admin)
       values ($1, $2, $3, '', $4, $5, true, 'e2e', true, $6)`,
      [user.id, user.email, user.name, FAKE_LOGIN_HOSTED_DOMAIN, `cus_e2e_${uniqueId}`, isAdmin],
    );
    return user;
  }
}
