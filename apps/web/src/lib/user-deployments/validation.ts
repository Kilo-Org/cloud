import { RESERVED_SLUGS, slugSchema, validateSlug } from '@kilocode/worker-utils/deployment-slug';
import * as z from 'zod';
import { providerSchema } from './types';

/**
 * Shared Zod schemas for deployment-related data.
 * These schemas are used by both the frontend and backend to ensure consistency.
 */

// Git branch name validation regex
const BRANCH_NAME_REGEX = /^[a-zA-Z0-9/_.-]+$/;

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

// Re-export deployment slug policy for compatibility with existing web imports.
export { RESERVED_SLUGS, slugSchema, validateSlug };

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
