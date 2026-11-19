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
 * - `NORMAL_LIST_ID` holds four open items with notes and one completed item,
 *   so the list shows both its open rows and its completed group.
 * - `LONG_LIST_ID` carries a list name and item titles that run past the row,
 *   which is the truncation case every to-do row and the detail header clamp.
 * - `DONE_LIST_ID` holds only completed items, so its open section is empty
 *   while the completed group is full.
 * - `EMPTY_LIST_ID` has no items, which is the list screen's own empty state.
 *
 * The lists are personal (`organization_id` null), so they reach Home's Up Next
 * section while no organization is selected: Home reads that section from the
 * selected account scope, and a selected organization shows that
 * organization's lists instead.
 *
 * A rerun deletes these four lists by their stable ids; `todo_items` cascades
 * from the list, so the second run ends with the same rows.
 */
const NORMAL_LIST_ID = '3b2f6a10-0000-4000-8000-5c1d2e3f4a01';
const LONG_LIST_ID = '3b2f6a10-0000-4000-8000-5c1d2e3f4a02';
const DONE_LIST_ID = '3b2f6a10-0000-4000-8000-5c1d2e3f4a03';
const EMPTY_LIST_ID = '3b2f6a10-0000-4000-8000-5c1d2e3f4a04';

const LIST_IDS = [NORMAL_LIST_ID, LONG_LIST_ID, DONE_LIST_ID, EMPTY_LIST_ID] as const;

const NORMAL_ITEM_ID = '3b2f6a10-0000-4000-8000-5c1d2e3f4b01';
const NORMAL_DONE_ITEM_ID = '3b2f6a10-0000-4000-8000-5c1d2e3f4b05';
const LONG_ITEM_ID = '3b2f6a10-0000-4000-8000-5c1d2e3f4b06';
const DONE_ITEM_ID = '3b2f6a10-0000-4000-8000-5c1d2e3f4b0a';

const HOUR_MS = 60 * 60 * 1000;

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

type ItemBlueprint = {
  id: string;
  listId: string;
  title: string;
  notes: string | null;
  position: string;
  doneAt: string | null;
};

/**
 * `todo_items` orders by done state first, then by position. Every open item
 * therefore keeps its position below the completed section, and the fixed
 * positions keep the order stable across reruns.
 */
const ITEMS: readonly ItemBlueprint[] = [
  {
    id: NORMAL_ITEM_ID,
    listId: NORMAL_LIST_ID,
    title: 'Write the release notes',
    notes: 'Name the three screens that changed, then link the migration.',
    position: 'a0',
    doneAt: null,
  },
  {
    id: '3b2f6a10-0000-4000-8000-5c1d2e3f4b02',
    listId: NORMAL_LIST_ID,
    title: 'Ask Dana to review the pricing copy',
    notes: null,
    position: 'a1',
    doneAt: null,
  },
  {
    id: '3b2f6a10-0000-4000-8000-5c1d2e3f4b03',
    listId: NORMAL_LIST_ID,
    title: 'Reproduce the retry loop on a slow network',
    notes:
      'Turn the connection profile down to 3G, open the agents list, and wait for the\r\n' +
      'retry banner. It should stop after the third attempt.',
    position: 'a2',
    doneAt: null,
  },
  {
    id: '3b2f6a10-0000-4000-8000-5c1d2e3f4b04',
    listId: NORMAL_LIST_ID,
    title: 'Send the weekly summary',
    notes: null,
    position: 'a3',
    doneAt: null,
  },
  {
    id: NORMAL_DONE_ITEM_ID,
    listId: NORMAL_LIST_ID,
    title: 'Merge the schema migration',
    notes: null,
    position: 'a4',
    doneAt: iso(-2 * HOUR_MS),
  },
  {
    id: LONG_ITEM_ID,
    listId: LONG_LIST_ID,
    title:
      'Rework the onboarding checklist so a new teammate can finish the first session, the first repository connection and the first pull request review without asking anyone',
    notes:
      'The checklist currently stops at the sign-in step. Each later step needs its own line, a\n' +
      'link to the screen it names, and a way back to the checklist after the step finishes.\n' +
      'Keep the order the product team wrote, because the sequence is the point.',
    position: 'a0',
    doneAt: null,
  },
  {
    id: '3b2f6a10-0000-4000-8000-5c1d2e3f4b07',
    listId: LONG_LIST_ID,
    title:
      'Decide whether the settings screen keeps its disclosure rows when the account runs a long organization name that pushes every control onto a second line',
    notes: null,
    position: 'a1',
    doneAt: null,
  },
  {
    id: '3b2f6a10-0000-4000-8000-5c1d2e3f4b08',
    listId: LONG_LIST_ID,
    title: 'Short one',
    notes: null,
    position: 'a2',
    doneAt: null,
  },
  {
    id: DONE_ITEM_ID,
    listId: DONE_LIST_ID,
    title: 'Book the offsite room',
    notes: null,
    position: 'a0',
    doneAt: iso(-26 * HOUR_MS),
  },
  {
    id: '3b2f6a10-0000-4000-8000-5c1d2e3f4b0b',
    listId: DONE_LIST_ID,
    title: 'Collect the snack preferences',
    notes: 'Two people asked for the same thing.',
    position: 'a1',
    doneAt: iso(-20 * HOUR_MS),
  },
  {
    id: '3b2f6a10-0000-4000-8000-5c1d2e3f4b0c',
    listId: DONE_LIST_ID,
    title: 'Send the calendar invite',
    notes: null,
    position: 'a2',
    doneAt: iso(-3 * HOUR_MS),
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

  // Reset only this topic's rows: the four stable list ids own every item by the
  // cascade on `todo_items`, so one delete clears both tables for them.
  await db.delete(todo_lists).where(inArray(todo_lists.id, [...LIST_IDS]));

  await db.insert(todo_lists).values([
    {
      id: NORMAL_LIST_ID,
      kilo_user_id: userId,
      organization_id: null,
      name: 'Ship the release',
      emoji: '🚀',
      position: 'a0',
    },
    {
      id: LONG_LIST_ID,
      kilo_user_id: userId,
      organization_id: null,
      name: 'Quarterly planning with a name long enough to clamp inside the list row',
      emoji: null,
      position: 'a1',
    },
    {
      id: DONE_LIST_ID,
      kilo_user_id: userId,
      organization_id: null,
      name: 'Finished this week',
      emoji: '✅',
      position: 'a2',
    },
    {
      id: EMPTY_LIST_ID,
      kilo_user_id: userId,
      organization_id: null,
      name: 'Nothing here yet',
      emoji: null,
      position: 'a3',
    },
  ]);

  await db.insert(todo_items).values(
    ITEMS.map(item => ({
      id: item.id,
      list_id: item.listId,
      kilo_user_id: userId,
      title: item.title,
      notes: item.notes,
      position: item.position,
      done_at: item.doneAt,
    }))
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
    normalListId: NORMAL_LIST_ID,
    normalListDeepLink: `kiloapp:///(app)/todos/${NORMAL_LIST_ID}`,
    longListId: LONG_LIST_ID,
    longListDeepLink: `kiloapp:///(app)/todos/${LONG_LIST_ID}`,
    doneListId: DONE_LIST_ID,
    doneListDeepLink: `kiloapp:///(app)/todos/${DONE_LIST_ID}`,
    emptyListId: EMPTY_LIST_ID,
    emptyListDeepLink: `kiloapp:///(app)/todos/${EMPTY_LIST_ID}`,
    openItemId: NORMAL_ITEM_ID,
    openItemDeepLink: `kiloapp:///(app)/todos/item/${NORMAL_ITEM_ID}`,
    doneItemId: NORMAL_DONE_ITEM_ID,
    doneItemDeepLink: `kiloapp:///(app)/todos/item/${NORMAL_DONE_ITEM_ID}`,
    longItemId: LONG_ITEM_ID,
    longItemDeepLink: `kiloapp:///(app)/todos/item/${LONG_ITEM_ID}`,
    homeDeepLink: 'kiloapp:///(app)/(tabs)/(0_home)',
  };
}
