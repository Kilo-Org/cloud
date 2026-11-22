import { randomUUID } from 'node:crypto';
import { expect, it, onTestFinished } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDrizzleClient } from '@kilocode/db/client';
import {
  agent_environment_profile_agents,
  agent_environment_profiles,
  kilocode_users,
} from '@kilocode/db/schema';
import { getAgentsForSession, listAgentsForProfile } from '@kilocode/cloud-agent-profile';

it('materializes only the profile agents that carry an id of their own'), async () => {
  const connectionString = process.env.POSTGRES_URL;
  if (
    !connectionString ||
    !['localhost', '127.0.0.1'].includes(new URL(connectionString).hostname)
  ) {
    throw new Error('Reserved agent slug regression requires a migrated local Postgres database');
  }
  const client = createDrizzleClient({ connectionString, poolConfig: { max: 1 }, ssl: false });
  const userId = `profile-agent-id-test-${randomUUID()}`;
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
    google_user_name: 'Synthetic agent id fixture',
    google_user_image_url: 'https://example.com/avatar.png',
    stripe_customer_id: `cus_${userId}`,
  });
  const [profile] = await client.db
    .insert(agent_environment_profiles)
    .values({ owned_by_user_id: userId, name: 'Synthetic agent ids' })
    .returning({ id: agent_environment_profiles.id });
  if (!profile) throw new Error('Synthetic profile was not created');

  // A row stored under an earlier slug rule: the store still holds it, and the
  // editor still lists it so its author can give it an id of its own.
  await client.db.insert(agent_environment_profile_agents).values([
    { profile_id: profile.id, slug: 'explore', name: 'Explore copy', config: {} },
    { profile_id: profile.id, slug: 'general', name: 'General copy', config: {} },
    { profile_id: profile.id, slug: 'reviewer', name: 'Reviewer', config: { prompt: 'Review.' } },
  ]);

  await expect(listAgentsForProfile(client.db, profile.id)).resolves.toMatchObject([
    { slug: 'explore' },
    { slug: 'general' },
    { slug: 'reviewer' },
  ]);
  await expect(getAgentsForSession(client.db, profile.id)).resolves.toEqual([
    { slug: 'reviewer', name: 'Reviewer', config: { prompt: 'Review.' } },
  ]);
});
