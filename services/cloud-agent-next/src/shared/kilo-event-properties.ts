export function gateResultFromProperties(
  properties: Record<string, unknown>
): 'pass' | 'fail' | undefined {
  const gateResult = properties.gateResult;
  return gateResult === 'pass' || gateResult === 'fail' ? gateResult : undefined;
}

export function permissionCategoryFromProperties(properties: Record<string, unknown>): string {
  const permission = properties.permission;
  if (typeof permission === 'object' && permission !== null && !Array.isArray(permission)) {
    if ('type' in permission && typeof permission.type === 'string') return permission.type;
    if ('tool' in permission && typeof permission.tool === 'string') return permission.tool;
  }
  if (typeof permission !== 'string') return 'unknown';
  const normalized = permission.toLowerCase();
  if (normalized.includes('glab')) return 'bash:glab';
  if (normalized === 'gh' || normalized.includes('gh ')) return 'bash:gh';
  if (normalized.includes('git ')) return 'bash:git';
  if (normalized.includes('bash')) return 'bash';
  if (normalized.includes('edit')) return 'edit';
  if (normalized.includes('web')) return 'web';
  return 'unknown';
}
