import 'server-only';

import { db, type DrizzleTransaction } from '@/lib/drizzle';
import type { Owner } from '@/lib/integrations/core/types';
import { platformIntegrationHealthSql } from '@/lib/integrations/core/health';
import { platform_integrations } from '@kilocode/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';

export async function assertGitHubAutomationCanBeEnabled(
  owner: Owner,
  executor: typeof db | DrizzleTransaction = db
): Promise<void> {
  await executor.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`${owner.type}:${owner.id}`}))`
  );
  const integrations = await executor
    .select({ role: platform_integrations.github_connection_role })
    .from(platform_integrations)
    .where(
      and(
        owner.type === 'org'
          ? eq(platform_integrations.owned_by_organization_id, owner.id)
          : eq(platform_integrations.owned_by_user_id, owner.id),
        eq(platform_integrations.platform, 'github'),
        platformIntegrationHealthSql()
      )
    );
  if (
    integrations.some(integration => integration.role === 'agent_only') &&
    !integrations.some(integration => integration.role === 'workflow')
  ) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Agent access connections support Slack and Cloud Agent only',
    });
  }
}
