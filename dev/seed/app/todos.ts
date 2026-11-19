import { createHash } from 'node:crypto';

import { todo_items, todo_lists } from '@kilocode/db/schema';
import { inArray } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import { resolveSeedUserId } from '../lib/users';

export const usage = '<email>';

/**
 * Personal to-do lists for one seeded account, one per state the to-do screens
 * have:
 *
 * - the first list holds four open items with notes and one completed item, so
 *   the list shows both its open rows and its completed group.
 * - the second carries a list name and item titles that run past the row, which
 *   is the truncation case every to-do row and the detail header clamp.
 * - the third holds only completed items, so its open section is empty while the
 *   completed group is full.
 * - the fourth has no items, which is the list screen's own empty state.
 *
 * The lists are personal (`organization_id` null), so they reach Home's Up Next
 * section while no organization is selected: Home reads that section from the
 * selected account scope, and a selected organization shows that
 * organization's lists instead.
 *
 * Every id is derived from the account, so two seeded accounts keep their own
 * rows and a rerun replaces the same ones. `position` uses the app's own
 * fractional key alphabet (`apps/web/src/lib/todos/position.ts`): a key must end
 * in a character other than `0`, and `todos.items.create` throws on one that
 * does, so an added or reordered item needs these keys to parse.
 */
const HOUR_MS = 60 * 60 * 1000;

/** Stable UUID for one account's fixture key: a rerun replaces the same rows. */
function seedUuid(key: string): string {
  const hex = createHash('md5').update(`app:todos:${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

type ItemBlueprint = {
  key: string;
  title: string;
  notes: string | null;
  position: string;
  doneAt: string | null;
};

type ListBlueprint = {
  key: string;
  name: string;
  emoji: string | null;
  position: string;
  items: readonly ItemBlueprint[];
};

/**
 * `todo_items` orders by done state first, then by position. Every open item
 * therefore keeps its position below the completed section, and the fixed
 * positions keep the order stable across reruns.
 */
const LISTS: readonly ListBlueprint[] = [
  {
    key: 'normal',
    name: 'Ship the release',
    emoji: '🚀',
    position: 'a1',
    items: [
      {
        key: 'normal-1',
        title: 'Write the release notes',
        notes: 'Name the three screens that changed, then link the migration.',
        position: 'a1',
        doneAt: null,
      },
      {
        key: 'normal-2',
        title: 'Ask Dana to review the pricing copy',
        notes: null,
        position: 'a2',
        doneAt: null,
      },
      {
        key: 'normal-3',
        title: 'Reproduce the retry loop on a slow network',
        notes:
          'Turn the connection profile down to 3G, open the agents list, and wait for the\n' +
          'retry banner. It should stop after the third attempt.',
        position: 'a3',
        doneAt: null,
      },
      {
        key: 'normal-4',
        title: 'Send the weekly summary',
        notes: null,
        position: 'a4',
        doneAt: null,
      },
      {
        key: 'normal-done',
        title: 'Merge the schema migration',
        notes: null,
        position: 'a5',
        doneAt: iso(-2 * HOUR_MS),
      },
    ],
  },
  {
    key: 'long',
    name: 'Quarterly planning with a name long enough to clamp inside the list row',
    emoji: null,
    position: 'a2',
    items: [
      {
        key: 'long-1',
        title:
          'Rework the onboarding checklist so a new teammate can finish the first session, the first repository connection and the first pull request review without asking anyone',
        notes:
          'The checklist currently stops at the sign-in step. Each later step needs its own line, a\n' +
          'link to the screen it names, and a way back to the checklist after the step finishes.\n' +
          'Keep the order the product team wrote, because the sequence is the point.',
        position: 'a1',
        doneAt: null,
      },
      {
        key: 'long-2',
        title:
          'Decide whether the settings screen keeps its disclosure rows when the account runs a long organization name that pushes every control onto a second line',
        notes: null,
        position: 'a2',
        doneAt: null,
      },
      {
        key: 'long-3',
        title: 'Short one',
        notes: null,
        position: 'a3',
        doneAt: null,
      },
    ],
  },
  {
    key: 'done',
    name: 'Finished this week',
    emoji: '✅',
    position: 'a3',
    items: [
      {
        key: 'done-1',
        title: 'Book the offsite room',
        notes: null,
        position: 'a1',
        doneAt: iso(-26 * HOUR_MS),
      },
      {
        key: 'done-2',
        title: 'Collect the snack preferences',
        notes: 'Two people asked for the same thing.',
        position: 'a2',
        doneAt: iso(-20 * HOUR_MS),
      },
      {
        key: 'done-3',
        title: 'Send the calendar invite',
        notes: null,
        position: 'a3',
        doneAt: iso(-3 * HOUR_MS),
      },
    ],
  },
  {
    key: 'empty',
    name: 'Nothing here yet',
    emoji: null,
    position: 'a4',
    items: [],
  },
];

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:todos ${usage}`);
  console.log('');
  console.log('Seeds four personal to-do lists for one existing seeded account: one with open');
  console.log('and completed items, one with long titles, one with only completed items, and');
  console.log('one empty list. Requires a localhost database; never calls a provider.');
  console.log('');
  console.log('Open the returned deep links in the signed-in mobile development client. Home');
  console.log('shows the Up Next items while no organization is selected.');
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  const [email, ...rest] = args;
  if (!email || rest.length) {
    printUsage();
    throw new Error(`Pass one seeded account email: pnpm dev:seed app:todos ${email ?? '<email>'}`);
  }
  assertLocalSeedDatabase('app:todos');
  if (process.env.NODE_ENV === 'production') {
    throw new Error('This fixture requires a local development database.');
  }

  const normalizedEmail = normalizeSeedEmail(email.trim());
  const userId = await resolveSeedUserId(normalizedEmail);
  const db = getSeedDb();
  const listId = (key: string) => seedUuid(`${userId}:list:${key}`);

  // Reset only this topic's rows for this account: the four stable list ids own
  // every item by the cascade on `todo_items`, so one delete clears both tables.
  await db.delete(todo_lists).where(
    inArray(
      todo_lists.id,
      LISTS.map(list => listId(list.key))
    )
  );

  await db.insert(todo_lists).values(
    LISTS.map(list => ({
      id: listId(list.key),
      kilo_user_id: userId,
      organization_id: null,
      name: list.name,
      emoji: list.emoji,
      position: list.position,
    }))
  );

  await db.insert(todo_items).values(
    LISTS.flatMap(list =>
      list.items.map(item => ({
        id: seedUuid(`${userId}:item:${item.key}`),
        list_id: listId(list.key),
        kilo_user_id: userId,
        title: item.title,
        notes: item.notes,
        position: item.position,
        done_at: item.doneAt,
      }))
    )
  );

  console.log('This fixture represents:');
  console.log('  Four personal to-do lists — mixed open and completed, long titles, all');
  console.log(
    '  completed, and empty — for the to-do list, to-do detail and Home Up Next screens.'
  );
  console.log('Suggested next step:');
  console.log(
    '  Open a returned deep link in the signed-in mobile app with no organization selected.'
  );

  return {
    userId,
    email: normalizedEmail,
    normalListId: listId('normal'),
    normalListDeepLink: `kiloapp:///(app)/todos/${listId('normal')}`,
    longListId: listId('long'),
    longListDeepLink: `kiloapp:///(app)/todos/${listId('long')}`,
    doneListId: listId('done'),
    doneListDeepLink: `kiloapp:///(app)/todos/${listId('done')}`,
    emptyListId: listId('empty'),
    emptyListDeepLink: `kiloapp:///(app)/todos/${listId('empty')}`,
    openItemId: seedUuid(`${userId}:item:normal-1`),
    openItemDeepLink: `kiloapp:///(app)/todos/item/${seedUuid(`${userId}:item:normal-1`)}`,
    doneItemId: seedUuid(`${userId}:item:normal-done`),
    doneItemDeepLink: `kiloapp:///(app)/todos/item/${seedUuid(`${userId}:item:normal-done`)}`,
    longItemId: seedUuid(`${userId}:item:long-1`),
    longItemDeepLink: `kiloapp:///(app)/todos/item/${seedUuid(`${userId}:item:long-1`)}`,
    homeDeepLink: 'kiloapp:///(app)/(tabs)/(0_home)',
  };
}
