import '@/lib/load-env';

import { z } from 'zod';
import { backfillGitHubInstallations } from '@/lib/integrations/db/github-installations-backfill';
import { closeAllDrizzleConnections } from '@/lib/drizzle';

const Args = z.object({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const rawArgs = Object.fromEntries(
  process.argv.slice(2).map(argument => {
    const [key, value] = argument.replace(/^--/, '').split('=', 2);
    return [key, value];
  })
);
async function main() {
  const args = Args.parse(rawArgs);
  try {
    const result = await backfillGitHubInstallations(args.limit, args.cursor);
    console.log(JSON.stringify(result));
    if (result.skipped > 0) {
      console.warn(
        'Backfill scanned rows requiring reconciliation; do not treat scan completion as full coverage.'
      );
    }
  } finally {
    await closeAllDrizzleConnections();
  }
}

void main();
