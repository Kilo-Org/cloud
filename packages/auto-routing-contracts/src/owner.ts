import * as z from 'zod';

/**
 * Who owns an auto-routing configuration: one user or one organization.
 *
 * Leaf module: it imports nothing but zod, so `benchmark.ts`, `custom-router.ts`
 * and the package root can all share it without a package-root cycle.
 */
export const OwnerTypeSchema = z.enum(['user', 'org']);
export type OwnerType = z.infer<typeof OwnerTypeSchema>;
