export type InternalSessionAuthMethod = 'bearer' | 'legacy';

export function isLegacyInternalSessionAuthEnabled(value: string | undefined): boolean {
  return value === undefined || value === '' || value === 'true';
}
