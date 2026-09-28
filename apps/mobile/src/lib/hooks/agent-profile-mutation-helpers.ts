import { type MutationOptions } from '@tanstack/react-query';

/**
 * Add the hook's context organization to a mutation's input, so every screen
 * under the same context does not repeat `organizationId` at each call site.
 * `organizationId` is optional in every `agentProfiles.*` input, so the merged
 * object is still the procedure's input type.
 *
 * Shared by the profile-management mutation hooks so their inputs carry the same
 * organization context.
 */
export function withOrganization<
  TData,
  TError,
  TVariables extends { organizationId?: string },
  TContext,
>(
  options: MutationOptions<TData, TError, TVariables, TContext>,
  organizationId: string | undefined
): MutationOptions<TData, TError, TVariables, TContext> {
  const mutationFn = options.mutationFn;
  if (!mutationFn || organizationId === undefined) {
    return options;
  }
  return {
    ...options,
    // The wrapper must return the underlying promise unchanged; `async` without
    // an await trips `require-await` (same conflict noted in use-code-reviewer).
    // eslint-disable-next-line typescript-eslint/promise-function-async -- wraps a promise-returning mutationFn
    mutationFn: (variables, context) => mutationFn({ ...variables, organizationId }, context),
  };
}
