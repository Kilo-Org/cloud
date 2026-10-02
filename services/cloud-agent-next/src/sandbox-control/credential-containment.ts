import { z } from 'zod';

export const credentialContainmentSchema = z
  .object({
    kilocode: z.boolean(),
    github: z.boolean(),
    worktreeScoped: z.literal(true).optional(),
  })
  .strict();

export type CredentialContainmentRequirements = z.infer<typeof credentialContainmentSchema>;

export const WORKTREE_CREDENTIAL_CONTAINMENT = {
  kilocode: true,
  github: true,
  worktreeScoped: true,
} satisfies CredentialContainmentRequirements;

export function getWorktreeCredentialContainment(
  enabled: boolean
): CredentialContainmentRequirements {
  return enabled
    ? WORKTREE_CREDENTIAL_CONTAINMENT
    : { kilocode: false, github: false, worktreeScoped: true };
}
