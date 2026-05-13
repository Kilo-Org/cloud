export function getNewAgentSessionPath(organizationId: string | null): string {
  return organizationId
    ? `/(app)/agent-chat/new?organizationId=${organizationId}`
    : '/(app)/agent-chat/new';
}
