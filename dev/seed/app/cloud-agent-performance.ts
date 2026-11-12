import { createHash, randomUUID } from 'node:crypto';
import {
  cli_sessions_v2,
  cloud_agent_workspace_folders,
  cloud_agent_worktrees,
  kilocode_users,
} from '@kilocode/db/schema';
import { and, eq, like } from 'drizzle-orm';
import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';
import type { SeedResult } from '../index';

export const usage = '<existing-user-email> [workspace-count=120] [chats-per-workspace=8]';

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: pnpm dev:seed app:cloud-agent-performance ${usage}`);
    console.log('Seeds local sidebar load; transcripts and live runtimes are not fabricated.');
    return;
  }
  const [email, workspaceArg = '120', chatsArg = '8', ...rest] = args;
  const workspaceCount = Number(workspaceArg);
  const chatsPerWorkspace = Number(chatsArg);
  if (
    !email ||
    rest.length > 0 ||
    !Number.isInteger(workspaceCount) ||
    workspaceCount < 1 ||
    workspaceCount > 1000 ||
    !Number.isInteger(chatsPerWorkspace) ||
    chatsPerWorkspace < 1 ||
    chatsPerWorkspace > 100
  ) {
    throw new Error(`Usage: pnpm dev:seed app:cloud-agent-performance ${usage}`);
  }
  assertLocalSeedDatabase('app:cloud-agent-performance');
  const db = getSeedDb();
  const [user] = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(eq(kilocode_users.google_user_email, email));
  if (!user) throw new Error('Create the local user with fake login first.');
  const prefix = `dev-seed:cloud-performance:${createHash('sha256').update(user.id).digest('hex').slice(0, 12)}:`;
  const folderCount = Math.min(12, workspaceCount);
  await db.transaction(async tx => {
    await tx
      .delete(cli_sessions_v2)
      .where(
        and(
          eq(cli_sessions_v2.kilo_user_id, user.id),
          like(cli_sessions_v2.session_id, `${prefix}%`)
        )
      );
    await tx
      .delete(cloud_agent_worktrees)
      .where(
        and(
          eq(cloud_agent_worktrees.kilo_user_id, user.id),
          like(cloud_agent_worktrees.name, `${prefix}%`)
        )
      );
    await tx
      .delete(cloud_agent_workspace_folders)
      .where(
        and(
          eq(cloud_agent_workspace_folders.kilo_user_id, user.id),
          like(cloud_agent_workspace_folders.name, `${prefix}%`)
        )
      );
    const folders = Array.from(
      { length: folderCount },
      (_, index) =>
        ({
          id: randomUUID(),
          kilo_user_id: user.id,
          name: `${prefix}Project ${index + 1}`,
          position: index,
        }) satisfies typeof cloud_agent_workspace_folders.$inferInsert
    );
    await tx.insert(cloud_agent_workspace_folders).values(folders);
    for (let index = 0; index < workspaceCount; index++) {
      const worktreeId = `worktree_${randomUUID()}`;
      const folder = folders[index % (folderCount + 1)];
      const createdAt = new Date(Date.now() - index * 60_000).toISOString();
      await tx.insert(cloud_agent_worktrees).values({
        worktree_id: worktreeId,
        kilo_user_id: user.id,
        folder_id: folder?.id ?? null,
        name: `${prefix}Workspace ${index + 1}`,
        created_at: createdAt,
      });
      await tx.insert(cli_sessions_v2).values(
        Array.from(
          { length: chatsPerWorkspace },
          (_, chat) =>
            ({
              session_id: `${prefix}${index}:${chat}`,
              kilo_user_id: user.id,
              cloud_agent_worktree_id: worktreeId,
              title: `Performance workspace ${index + 1}, chat ${chat + 1}`,
              created_on_platform: 'cloud-agent-web',
              git_url: 'https://github.com/octocat/Hello-World.git',
              git_branch: `perf/workspace-${index + 1}`,
              status: 'idle',
              created_at: createdAt,
              updated_at: createdAt,
              last_activity_at: createdAt,
            }) satisfies typeof cli_sessions_v2.$inferInsert
        )
      );
    }
  });
  console.log('Sidebar load fixture only. Add real fake-LLM chats for transcript measurements.');
  return {
    userId: user.id,
    email,
    workspaceCount,
    sessionCount: workspaceCount * chatsPerWorkspace,
    folderCount,
  };
}
