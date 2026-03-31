const AGENT_STATUS_PRIORITY: Record<string, number> = {
  working: 0,
  starting: 1,
  active: 2,
  idle: 3,
  stalled: 4,
  blocked: 4,
  exited: 5,
  failed: 5,
  dead: 5,
};

export function sortAgentsByStatus<
  T extends { status: string; last_activity_at: string | null; created_at: string },
>(agents: T[]): T[] {
  return [...agents].sort((a, b) => {
    const aPri = AGENT_STATUS_PRIORITY[a.status] ?? 6;
    const bPri = AGENT_STATUS_PRIORITY[b.status] ?? 6;
    if (aPri !== bPri) return aPri - bPri;
    const aTime = new Date(a.last_activity_at ?? a.created_at).getTime();
    const bTime = new Date(b.last_activity_at ?? b.created_at).getTime();
    return bTime - aTime;
  });
}
