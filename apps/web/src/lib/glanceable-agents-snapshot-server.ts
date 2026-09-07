import 'server-only';
import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';

import { listActiveSessions } from '@/lib/active-sessions-list';

/**
 * Server-side snapshot for background glanceable delivery (Live Activity,
 * widgets, Android ongoing). Builds the same versioned, privacy-minimal shape
 * the mobile publisher derives from its own tray cache — the snapshot is the
 * extracted active-sessions list, never a second session source.
 *
 * The shared `buildGlanceableSnapshot` reads only each session's `status`, so
 * title, git, id, and every other raw field are structurally excluded from the
 * output. `accountEpoch` is intentionally omitted: the mobile client applies
 * its own local epoch when it adopts a remote snapshot.
 */
export async function buildGlanceableSnapshotForUser({
  userId,
  organizationId,
}: {
  userId: string;
  organizationId: string | null;
}): Promise<GlanceableAgentsSnapshot> {
  const { sessions } = await listActiveSessions({
    userId,
    organizationId,
    includeCloudAgentSessions: true,
  });

  return buildGlanceableSnapshot({
    sessions,
    userId,
    organizationId,
    now: Date.now(),
  });
}
