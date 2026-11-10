import { randomUUID } from 'node:crypto';
import { expect, it, onTestFinished } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDrizzleClient } from '@kilocode/db/client';
import {
  agent_environment_profiles,
  agent_environment_profile_instructions,
  kilocode_users,
} from '@kilocode/db/schema';
import { getInstructionsForSession } from '@kilocode/cloud-agent-profile';
import { controlPlaneRouteSpecSchema } from '../../src/shared/control-plane-protocol.js';
import { workspaceConfigFromSpec } from '../../src/shared/workspace-config.js';

it('delivers only enabled saved profile instructions in shared workspace configuration', async () => {
  const connectionString = process.env.POSTGRES_URL;
  if (
    !connectionString ||
    !['localhost', '127.0.0.1'].includes(new URL(connectionString).hostname)
  ) {
    throw new Error('Instruction delivery regression requires a migrated local Postgres database');
  }
  const client = createDrizzleClient({ connectionString, poolConfig: { max: 1 }, ssl: false });
  const userId = `instruction-delivery-test-${randomUUID()}`;
  onTestFinished(async () => {
    try {
      await client.db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
    } finally {
      await client.pool.end();
    }
  });
  await client.db.insert(kilocode_users).values({
    id: userId,
    google_user_email: `${userId}@example.com`,
    google_user_name: 'Synthetic instruction fixture',
    google_user_image_url: 'https://example.com/avatar.png',
    stripe_customer_id: `cus_${userId}`,
  });
  const [profile] = await client.db
    .insert(agent_environment_profiles)
    .values({ owned_by_user_id: userId, name: 'Synthetic instruction delivery' })
    .returning({ id: agent_environment_profiles.id });
  if (!profile) throw new Error('Synthetic profile was not created');
  await client.db.insert(agent_environment_profile_instructions).values([
    {
      profile_id: profile.id,
      name: 'enabled-proof',
      content: 'SYNTHETIC_ENABLED',
      enabled: true,
    },
    {
      profile_id: profile.id,
      name: 'disabled-proof',
      content: 'SYNTHETIC_DISABLED',
      enabled: false,
    },
  ]);
  const instructions = await getInstructionsForSession(client.db, profile.id);
  const spec = controlPlaneRouteSpecSchema.parse({
    sessionId: 'workspace_synthetic',
    kiloSessionId: 'ses_synthetic',
    directory: '/workspace/shared',
    attemptId: 'synthetic-attempt',
    runtimeInstructions: instructions,
  });
  expect(workspaceConfigFromSpec(spec, undefined).runtimeInstructions).toEqual([
    { name: 'enabled-proof', content: 'SYNTHETIC_ENABLED' },
  ]);
});
