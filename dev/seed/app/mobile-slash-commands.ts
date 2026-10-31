import { computeDatabaseUrl } from '@kilocode/db';
import {
  agent_environment_profile_kilo_commands,
  agent_environment_profiles,
  kilocode_users,
} from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { getSeedDb } from '../lib/db';

export const usage = '<fake-email>';

const PROFILE_NAME = 'Slash command fixture';
const COMMAND_NAME = 'my-review';
const BODY_LINES = 60;

/**
 * The template's first line runs past the row's preview bound, so the row shows
 * where the preview ends instead of the whole line.
 */
const FIRST_LINE =
  'Review the diff for the Arabic reviewer, then explain the failing login test and its cause';

/** A template shaped like a pasted command body: long first line, then many lines. */
function fixtureTemplate(): string {
  const body = Array.from(
    { length: BODY_LINES },
    (_, index) => `line ${index}: a body line the row never draws, with مرحبا and 👨‍👩‍👧 text`
  );
  return [FIRST_LINE, ...body].join('\n');
}

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:mobile-slash-commands ${usage}`);
  console.log('');
  console.log('Seeds one profile on an existing local fake account with one slash');
  console.log('command whose stored template is several KB across many lines.');
  console.log('Resets only that profile and its commands.');
  console.log('');
  console.log('Examples:');
  console.log('  pnpm dev:seed app:mobile-slash-commands ada@example.com');
  console.log('  pnpm -s dev:seed app:mobile-slash-commands ada@example.com --json');
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  const [email, ...extra] = args;
  if (!email || extra.length > 0) {
    printUsage();
    throw new Error('one fake account email is required');
  }
  if (!/^[a-z0-9][a-z0-9._+-]*@example\.com$/i.test(email)) {
    throw new Error(`Not a local fake account email: ${email}`);
  }
  const host = new URL(computeDatabaseUrl()).hostname;
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(host) ||
    process.env.NODE_ENV === 'production'
  ) {
    throw new Error('This fixture requires a local development database.');
  }

  const normalizedEmail = email.toLowerCase();
  const db = getSeedDb();
  const [user] = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(eq(kilocode_users.normalized_email, normalizedEmail));
  if (!user) {
    throw new Error(`No local account for ${email}; create it before seeding this fixture.`);
  }

  await db
    .delete(agent_environment_profiles)
    .where(
      and(
        eq(agent_environment_profiles.owned_by_user_id, user.id),
        eq(agent_environment_profiles.name, PROFILE_NAME)
      )
    );
  const [profile] = await db
    .insert(agent_environment_profiles)
    .values({
      owned_by_user_id: user.id,
      created_by_user_id: user.id,
      name: PROFILE_NAME,
      description: 'Fixture profile for the slash command row',
      is_default: false,
    })
    .returning({ id: agent_environment_profiles.id });
  if (!profile) {
    throw new Error('The fixture profile was not inserted.');
  }

  const template = fixtureTemplate();
  const [command] = await db
    .insert(agent_environment_profile_kilo_commands)
    .values({
      profile_id: profile.id,
      name: COMMAND_NAME,
      description: 'Review a change',
      template,
      subtask: false,
      enabled: true,
      sort_order: 0,
    })
    .returning({ id: agent_environment_profile_kilo_commands.id });
  if (!command) {
    throw new Error('The fixture command was not inserted.');
  }

  console.log(
    'This fixture represents: one slash command whose stored template is several KB across many lines.'
  );
  console.log(
    'Open its deep link in a development client signed in as this account; the row shows one bounded preview line.'
  );
  return {
    email,
    userId: user.id,
    profileId: profile.id,
    commandId: command.id,
    commandName: `/${COMMAND_NAME}`,
    templateCharacters: template.length,
    deepLink: `kiloapp:///profiles/${profile.id}/slash-commands`,
  };
}
