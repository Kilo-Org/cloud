import { getTable } from '../table.js';

// Table query interpolator for organization membership verification
export const organization_memberships = getTable({
  name: 'organization_memberships',
  columns: ['id', 'organization_id', 'kilo_user_id', 'role'] as const,
});
