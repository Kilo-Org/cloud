import { device_sessions, kilocode_users } from '@kilocode/db/schema';
import { eq, inArray, or } from 'drizzle-orm';

import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import { isValidEmail } from '../lib/users';
import type { SeedResult } from '../index';

export const usage = '<email> [options]';

/**
 * One row per client kind the Device sessions screen renders. The user agents
 * are the ones the clients really send, so the screen's server-side
 * classification is exercised end to end rather than a fixture-only shape:
 *
 * - `Kilo-Code/<version> (android|ios)` is the app's own header
 *   (`apps/mobile/src/lib/client-metadata.ts`).
 * - `okhttp/<version>` is what the app recorded before that header existed.
 * - `Kilo-Code/<version>` with no platform word is the CLI's header.
 * - `Mozilla/5.0 …` is a browser.
 * - A bare product token is any other client.
 *
 * Each row carries a fixed primary key, so a rerun replaces its own rows by id.
 * A user agent cannot identify them: a real session may send the same header.
 */
const FIXTURE_SESSIONS = [
  {
    id: '1f0d3a52-6a0b-4c4e-9a51-0d1e2b3c4a01',
    label: 'android',
    userAgent: 'Kilo-Code/1.4.0 (android)',
    daysAgo: 1,
  },
  {
    id: '1f0d3a52-6a0b-4c4e-9a51-0d1e2b3c4a02',
    label: 'ios',
    userAgent: 'Kilo-Code/1.4.0 (ios)',
    daysAgo: 3,
  },
  {
    id: '1f0d3a52-6a0b-4c4e-9a51-0d1e2b3c4a03',
    label: 'legacyAndroid',
    userAgent: 'okhttp/4.9.2',
    daysAgo: 6,
  },
  {
    id: '1f0d3a52-6a0b-4c4e-9a51-0d1e2b3c4a04',
    label: 'cli',
    userAgent: 'Kilo-Code/1.4.0',
    daysAgo: 9,
  },
  {
    id: '1f0d3a52-6a0b-4c4e-9a51-0d1e2b3c4a05',
    label: 'browser',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15',
    daysAgo: 12,
  },
  {
    id: '1f0d3a52-6a0b-4c4e-9a51-0d1e2b3c4a06',
    label: 'other',
    userAgent: 'axios/1.7.0',
    daysAgo: 15,
  },
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

function printUsage(): void {
  console.log('Seed device sessions for one local user, one per client kind.');
  console.log('');
  console.log(`Usage: pnpm dev:seed app:device-sessions ${usage}`);
  console.log('');
  console.log('Options:');
  console.log('  --help, -h  Show this message.');
  console.log('');
  console.log('The topic replaces its own fixture rows, so a rerun is idempotent and');
  console.log('keeps any real session the user already has. Open Profile → Preferences →');
  console.log('Account → Device sessions in the mobile app to read them.');
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const email = args[0]?.trim();
  if (!email) {
    printUsage();
    throw new Error('email is required');
  }
  if (!isValidEmail(email)) {
    throw new Error(`email is not a valid address: ${email}`);
  }
  if (args.length > 1) {
    throw new Error(`Unknown argument: ${args[1]}`);
  }

  assertLocalSeedDatabase('app:device-sessions');
  const db = getSeedDb();
  const normalizedEmail = normalizeSeedEmail(email);
  const matches = await db
    .select({ id: kilocode_users.id, email: kilocode_users.google_user_email })
    .from(kilocode_users)
    .where(
      or(
        eq(kilocode_users.google_user_email, email),
        eq(kilocode_users.normalized_email, normalizedEmail)
      )
    );

  const exact = matches.filter(match => match.email === email);
  const resolved = exact.length > 0 ? exact : matches;
  if (resolved.length === 0) {
    throw new Error(
      `No user found for email ${email}. Sign in locally first, or seed a user (pnpm dev:seed app:create-user).`
    );
  }
  if (resolved.length > 1) {
    const listed = resolved.map(match => `${match.email} (${match.id})`).join(', ');
    throw new Error(`Multiple users matched ${email}: ${listed}`);
  }

  const [user] = resolved;
  const now = Date.now();

  // Reset only the rows this topic owns, so a rerun is idempotent and a real
  // sign-in session the user already has stays in the list. The rows are keyed
  // by their own ids: a real session can carry the same user agent.
  await db.delete(device_sessions).where(
    inArray(
      device_sessions.id,
      FIXTURE_SESSIONS.map(session => session.id)
    )
  );

  for (const session of FIXTURE_SESSIONS) {
    const lastSeenAt = new Date(now - session.daysAgo * DAY_MS).toISOString();
    await db.insert(device_sessions).values({
      id: session.id,
      kilo_user_id: user.id,
      user_agent: session.userAgent,
      created_at: new Date(now - (session.daysAgo + 2) * DAY_MS).toISOString(),
      last_seen_at: lastSeenAt,
    });
  }

  const rows = await db
    .select({ id: device_sessions.id, userAgent: device_sessions.user_agent })
    .from(device_sessions)
    .where(eq(device_sessions.kilo_user_id, user.id));

  return {
    email: user.email,
    sessions: rows.length,
    ...Object.fromEntries(FIXTURE_SESSIONS.map(session => [session.label, session.userAgent])),
  };
}
