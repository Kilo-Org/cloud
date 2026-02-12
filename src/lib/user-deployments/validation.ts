import * as z from 'zod';
import { providerSchema } from './types';

/**
 * Shared Zod schemas for deployment-related data.
 * These schemas are used by both the frontend and backend to ensure consistency.
 */

// Git branch name validation regex
const BRANCH_NAME_REGEX = /^[a-zA-Z0-9/_.-]+$/;

// Deployment slug validation regex
// Must start and end with alphanumeric, only lowercase letters, numbers, and single hyphens
const SLUG_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

// Matches the internal worker name format (dpl-<uuid>)
const INTERNAL_WORKER_NAME_REGEX = /^dpl-/;

// Repository name validation regex (owner/repo format)
const REPO_NAME_REGEX = /^[^/]+\/[^/]+$/;

// Re-export providerSchema from types for backward compatibility
export { providerSchema };

/**
 * Schema for validating repository name in owner/repo format
 */
export const repoNameSchema = z
  .string()
  .min(1, 'Repository name is required')
  .regex(REPO_NAME_REGEX, 'Repository name must be in owner/repo format');

/**
 * Schema for validating Git branch names.
 * Follows basic Git branch naming conventions.
 */
export const branchSchema = z
  .string()
  .min(1, 'Branch is required')
  .max(255, 'Branch must be at most 255 characters')
  .regex(BRANCH_NAME_REGEX, 'Branch name contains invalid characters');

/**
 * Reserved slugs that cannot be used for deployments.
 * These could cause confusion or security issues.
 */
export const RESERVED_SLUGS = [
  'www',
  'api',
  'app',
  'admin',
  'dashboard',
  'login',
  'auth',
  'static',
  'assets',
  'cdn',
  'mail',
  'email',
  'ftp',
  'ssh',
  'test',
  'staging',
  'dev',
  'prod',
  'production',
  'kilo',
  'kilocode',
  'kiloapps',
  'custom',
  'status',
  'health',
  'metrics',
] as const;

/**
 * Schema for validating deployment slugs (custom subdomains).
 * Must be valid for Cloudflare worker names and URL-safe.
 */
export const slugSchema = z
  .string()
  .min(3, 'Subdomain must be at least 3 characters')
  .max(63, 'Subdomain must be at most 63 characters')
  .regex(
    SLUG_REGEX,
    'Subdomain must start and end with a letter or number, and contain only lowercase letters, numbers, and hyphens'
  )
  .refine(slug => !slug.includes('--'), {
    message: 'Subdomain cannot contain consecutive hyphens',
  })
  .refine(slug => !RESERVED_SLUGS.includes(slug as (typeof RESERVED_SLUGS)[number]), {
    message: 'This subdomain is reserved',
  })
  .refine(slug => !INTERNAL_WORKER_NAME_REGEX.test(slug), {
    message: 'Subdomain cannot start with "dpl-"',
  });

/**
 * Shared validation functions for deployment-related data.
 * These functions provide user-friendly error messages for form validation.
 */

/**
 * Validate a provider and return a user-friendly error message if invalid.
 * @param provider - The provider to validate
 * @returns Error message string, or undefined if valid
 */
export function validateProvider(provider: string): string | undefined {
  const result = providerSchema.safeParse(provider);
  if (result.success) return undefined;
  return result.error.issues[0]?.message;
}

/**
 * Validate a repository name and return a user-friendly error message if invalid.
 * @param repoName - The repository name to validate (owner/repo format)
 * @returns Error message string, or undefined if valid
 */
export function validateRepoName(repoName: string): string | undefined {
  const result = repoNameSchema.safeParse(repoName);
  if (result.success) return undefined;
  return result.error.issues[0]?.message;
}

/**
 * Validate a branch name and return a user-friendly error message if invalid.
 * @param branch - The branch name to validate
 * @returns Error message string, or undefined if valid
 */
export function validateBranch(branch: string): string | undefined {
  const result = branchSchema.safeParse(branch);
  if (result.success) return undefined;
  return result.error.issues[0]?.message;
}

/**
 * Validate a deployment slug and return a user-friendly error message if invalid.
 * @param slug - The slug to validate
 * @returns Error message string, or undefined if valid
 */
export function validateSlug(slug: string): string | undefined {
  const result = slugSchema.safeParse(slug);
  if (result.success) return undefined;
  return result.error.issues[0]?.message;
}
