/**
 * Gets trigger-related routes for the given context (personal or org).
 */
export function getWebhookRoutes(organizationId?: string) {
  const base = organizationId
    ? `/organizations/${organizationId}/cloud/triggers`
    : '/cloud/triggers';

  return {
    list: base,
    create: `${base}/new`,
    edit: (triggerId: string) => `${base}/${triggerId}`,
    requests: (triggerId: string) => `${base}/${triggerId}/requests`,
  };
}
