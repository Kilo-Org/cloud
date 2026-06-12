export function getMcpGatewayRoutes(organizationId?: string) {
  const base = organizationId
    ? `/organizations/${organizationId}/cloud/mcp-gateway`
    : '/cloud/mcp-gateway';
  return {
    list: base,
    create: `${base}/new`,
    detail: (configId: string) => `${base}/${configId}`,
  };
}
