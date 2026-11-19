import * as z from 'zod';

/**
 * Who owns an auto-routing configuration: one user or one organization.
 *
 * `OwnerTypeSchema` names the kind, `OwnerIdSchema` the id, and `OwnerIdentityShape`/`OwnerSchema`
 * pair them so every contract that scopes a row to one owner declares the pair once.
 *
 * Leaf module: it imports nothing but zod, so `benchmark.ts`, `custom-router.ts`
 * and the package root can all share it without a package-root cycle.
 */
export const OwnerTypeSchema = z.enum(['user', 'org']);
export type OwnerType = z.infer<typeof OwnerTypeSchema>;

/** Owner ids are user ids or organization ids, stored trimmed and non-empty. */
export const OwnerIdSchema = z.string().trim().min(1);

/**
 * Field shape for the owner identity pair, so a schema that needs the pair spreads it and a
 * schema that needs both fields optional spreads `z.object(OwnerIdentityShape).partial().shape`.
 */
export const OwnerIdentityShape = { ownerType: OwnerTypeSchema, ownerId: OwnerIdSchema };
