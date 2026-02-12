import 'server-only';
import type { Owner } from '@/lib/integrations/core/types';
import { db } from '@/lib/drizzle';
import { app_builder_projects } from '@/db/schema';
import { TRPCError } from '@trpc/server';
import { eq, and } from 'drizzle-orm';
import type { AppBuilderProject } from '@/lib/app-builder/types';

export async function getProjectWithOwnershipCheck(
  projectId: string,
  owner: Owner
): Promise<AppBuilderProject> {
  const ownerCondition =
    owner.type === 'org'
      ? eq(app_builder_projects.owned_by_organization_id, owner.id)
      : eq(app_builder_projects.owned_by_user_id, owner.id);

  const [project] = await db
    .select()
    .from(app_builder_projects)
    .where(and(eq(app_builder_projects.id, projectId), ownerCondition));

  if (!project) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Project not found',
    });
  }

  return project;
}
