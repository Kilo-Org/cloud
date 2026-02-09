// Simple table interpolator for SQL queries
function getTable<T extends { name: string; columns: readonly string[] }>(table: T) {
  const columns: Record<string, string> = {};
  const prefixedColumns: Record<string, string> = {};

  for (const col of table.columns) {
    columns[col] = col;
    prefixedColumns[col] = `${table.name}.${col}`;
  }

  return {
    _name: table.name,
    columns,
    valueOf: () => table.name,
    toString: () => table.name,
    ...prefixedColumns,
  } as {
    _name: T['name'];
    columns: { [K in T['columns'][number]]: K };
    valueOf: () => T['name'];
    toString: () => T['name'];
  } & { [K in T['columns'][number]]: `${T['name']}.${K}` };
}

export const platform_integrations = getTable({
  name: 'platform_integrations',
  columns: [
    'id',
    'owned_by_user_id',
    'owned_by_organization_id',
    'platform',
    'integration_type',
    'platform_installation_id',
    'platform_account_login',
    'integration_status',
    'github_app_type',
  ] as const,
});

export const organization_memberships = getTable({
  name: 'organization_memberships',
  columns: ['id', 'organization_id', 'kilo_user_id', 'role'] as const,
});

export const kilocode_users = getTable({
  name: 'kilocode_users',
  columns: ['id', 'blocked_reason'] as const,
});
