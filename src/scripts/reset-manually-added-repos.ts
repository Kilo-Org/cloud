/**
 * Script to reset manually added repositories for a user's GitLab config
 *
 * Usage: pnpm script src/scripts/reset-manually-added-repos.ts
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

  // Update to reset manually_added_repositories and clean up selected_repository_ids
  const currentConfig = config.config as Record<string, unknown>;
  const selectedIds = (currentConfig.selected_repository_ids as number[]) || [];
  // Filter out negative IDs (invalid manually added repos)
  const cleanedSelectedIds = selectedIds.filter(id => id > 0);

  const updatedConfig = {
    ...currentConfig,
    manually_added_repositories: [],
    selected_repository_ids: cleanedSelectedIds,
  };

  await db
    .update(agent_configs)
    .set({ config: updatedConfig })
    .where(and(eq(agent_configs.owned_by_user_id, USER_ID), eq(agent_configs.platform, 'gitlab')));

  console.log('Reset manually_added_repositories to empty array');

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
