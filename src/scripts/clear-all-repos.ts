/**
 * Script to completely clear all repository selections for a user's GitLab config
 *
 * Usage: pnpm script src/scripts/clear-all-repos.ts
 */

import { db } from '@/lib/drizzle';
import { agent_configs } from '@/db/schema';
import { eq, and } from 'drizzle-orm';

const USER_ID = '324044ae-72cb-465a-933f-610a587e31ea';

async function main() {
  console.log('Fetching current config...');

  // First, let's see what's there
  const configs = await db
    .select()
    .from(agent_configs)
    .where(and(eq(agent_configs.owned_by_user_id, USER_ID), eq(agent_configs.platform, 'gitlab')));

  if (configs.length === 0) {
    console.log('No GitLab config found for user');
    return;
  }

  const config = configs[0];
  console.log('Current config:', JSON.stringify(config.config, null, 2));

  // Clear ALL repository selections
  const currentConfig = config.config as Record<string, unknown>;
  const updatedConfig = {
    ...currentConfig,
    manually_added_repositories: [],
    selected_repository_ids: [],
    repository_selection_mode: 'all', // Switch back to "all" mode
  };

  await db
    .update(agent_configs)
    .set({ config: updatedConfig })
    .where(and(eq(agent_configs.owned_by_user_id, USER_ID), eq(agent_configs.platform, 'gitlab')));

  console.log('Cleared all repository selections');

  // Verify
  const updated = await db
    .select()
    .from(agent_configs)
    .where(and(eq(agent_configs.owned_by_user_id, USER_ID), eq(agent_configs.platform, 'gitlab')));

  console.log('Updated config:', JSON.stringify(updated[0]?.config, null, 2));
}

main()
  .then(() => {
    console.log('Done');
    process.exit(0);
  })
  .catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
