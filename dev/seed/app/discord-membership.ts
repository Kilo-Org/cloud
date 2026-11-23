// Puts an existing dev user in a chosen Discord link/membership state for the
// guild-membership verify path.
//
// The OAuth link writes the same row this topic writes — `user_auth_provider`
// with `provider='discord'` and the Discord user id as `provider_account_id` —
// so the state below is the one a real link produces, minus the real account.
// The membership stamp on `kilocode_users` is what
// `checkDiscordGuildMembership` maintains on link and on the Profile verify
// action.
//
// Suggested next step: open Profile in the mobile app (the Discord connect/
// verify card reads `user:getDiscordGuildStatus`), or run
// `pnpm dev:mock-discord` and press Verify to exercise the real fetch.

import { createHash } from 'node:crypto';

import { kilocode_users, user_auth_provider } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';
import { isValidEmail } from '../lib/users';

export const usage = '<email> <member|not-member|unlinked> [--verified-at=<iso>]';

const STATES = ['member', 'not-member', 'unlinked'] as const;
type State = (typeof STATES)[number];

/**
 * The Discord account id this fixture links, derived from the Kilo user id so
 * every seeded account gets its own link (the primary key is provider plus
 * account id) and a rerun of the topic finds the same one. It is 18 digits, a
 * snowflake, so the verify path's `parseDiscordSnowflake` accepts it.
 */
function discordAccountIdFor(kiloUserId: string): string {
  const digest = createHash('sha256').update(kiloUserId).digest();
  const digits = (digest.readBigUInt64BE(0) % 900_000_000_000_000_000n) + 100_000_000_000_000_000n;
  return digits.toString();
}

function printUsage(): void {
  console.log('Put a local user in a chosen Discord link/membership state.');
  console.log('');
  console.log(`Usage: pnpm dev:seed app:discord-membership ${usage}`);
  console.log('');
  console.log('States:');
  console.log('  member      Link Discord and stamp discord_server_membership_verified_at.');
  console.log('  not-member  Link Discord with the stamp cleared, so Verify reports not a member.');
  console.log('  unlinked    Remove the Discord link and clear the stamp.');
  console.log('');
  console.log('Options:');
  console.log('  --verified-at=<iso>  Stamp this ISO time instead of now (member only).');
  console.log('  --help, -h           Show this message.');
  console.log('');
  console.log('The topic resets only its own two facts, so a rerun is idempotent.');
  console.log('Suggested next step: open Profile in the app, or run pnpm dev:mock-discord');
  console.log('and press Verify to exercise the real membership fetch.');
}

function parseState(value: string | undefined): State {
  const match = STATES.find(state => state === value);
  if (!match) {
    throw new Error(`state must be one of ${STATES.join(', ')}; received ${value ?? 'nothing'}`);
  }
  return match;
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const positional: string[] = [];
  let verifiedAtArgument: string | undefined;
  for (const arg of args) {
    if (arg.startsWith('--verified-at=')) {
      verifiedAtArgument = arg.slice('--verified-at='.length);
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }
    positional.push(arg);
  }

  const [email, stateArgument, ...rest] = positional;
  if (!email) {
    printUsage();
    throw new Error('email is required');
  }
  if (!isValidEmail(email)) {
    throw new Error(`email is not a valid address: ${email}`);
  }
  const state = parseState(stateArgument);
  if (rest.length > 0) {
    throw new Error(`Unexpected extra arguments: ${rest.join(' ')}`);
  }

  let verifiedAt: string | null = null;
  if (state === 'member') {
    if (verifiedAtArgument === undefined) {
      verifiedAt = new Date().toISOString();
    } else {
      const parsed = new Date(verifiedAtArgument);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error(`--verified-at is not a valid date: ${verifiedAtArgument}`);
      }
      verifiedAt = parsed.toISOString();
    }
  } else if (verifiedAtArgument !== undefined) {
    throw new Error(`--verified-at only applies to the member state`);
  }

  assertLocalSeedDatabase('app:discord-membership');
  const db = getSeedDb();

  const users = await db
    .select({
      id: kilocode_users.id,
      email: kilocode_users.google_user_email,
      name: kilocode_users.google_user_name,
      avatar: kilocode_users.google_user_image_url,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.google_user_email, email))
    .limit(2);

  const user = users[0];
  if (!user) {
    throw new Error(
      `No user found for email ${email}. Sign in locally first, or create one (pnpm dev:seed app:create-user).`
    );
  }
  if (users.length > 1) {
    throw new Error(`Multiple users matched ${email}; use an email that names one account.`);
  }

  // The account signs in by email, and the server infers that method only from
  // an account with no provider rows (`inferRowlessAuthProviders`). Writing the
  // Discord row would otherwise take the email method away, and the app would
  // answer `DIFFERENT-OAUTH` instead of sending a code. A real account that
  // linked Discord from the app keeps both rows, so the fixture writes both.
  await db
    .insert(user_auth_provider)
    .values({
      kilo_user_id: user.id,
      provider: 'email',
      provider_account_id: user.email,
      email: user.email,
      avatar_url: user.avatar,
      display_name: user.name,
    })
    .onConflictDoNothing();

  // Reset only this user's own two facts: the Discord link row and the stamp.
  await db
    .delete(user_auth_provider)
    .where(
      and(eq(user_auth_provider.kilo_user_id, user.id), eq(user_auth_provider.provider, 'discord'))
    );
  await db
    .update(kilocode_users)
    .set({ discord_server_membership_verified_at: null })
    .where(eq(kilocode_users.id, user.id));

  if (state !== 'unlinked') {
    await db.insert(user_auth_provider).values({
      kilo_user_id: user.id,
      provider: 'discord',
      provider_account_id: discordAccountIdFor(user.id),
      email: user.email,
      avatar_url: user.avatar,
      display_name: user.name,
    });
  }

  if (verifiedAt !== null) {
    await db
      .update(kilocode_users)
      .set({ discord_server_membership_verified_at: verifiedAt })
      .where(eq(kilocode_users.id, user.id));
  }

  // Read the two facts back so the reported result is the stored state.
  const [linkedRow] = await db
    .select({ accountId: user_auth_provider.provider_account_id })
    .from(user_auth_provider)
    .where(
      and(eq(user_auth_provider.kilo_user_id, user.id), eq(user_auth_provider.provider, 'discord'))
    );
  const [stampRow] = await db
    .select({ verifiedAt: kilocode_users.discord_server_membership_verified_at })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, user.id));

  console.log('This fixture represents: one account in a chosen Discord link/membership state.');
  if (state === 'member') {
    console.log('Note: Verify reports a member only while the mock answers 200 for this account.');
  } else if (state === 'not-member') {
    console.log('Note: Verify clears the stamp from a real fetch; it is already clear here.');
  } else {
    console.log('Note: Verify refuses to run until Discord is linked again.');
  }
  console.log('Suggested next step: open Profile in the app, or run pnpm dev:mock-discord.');

  return {
    userId: user.id,
    email: user.email,
    state,
    discordAccountId: linkedRow?.accountId ?? null,
    discordServerMembershipVerifiedAt: stampRow?.verifiedAt ?? null,
  };
}
