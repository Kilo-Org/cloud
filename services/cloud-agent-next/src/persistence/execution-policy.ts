import { PermissionConfigSchema } from '@kilocode/db/schema-types';
import * as z from 'zod';
import { buildCodeReviewManagedSessionPolicy } from '@kilocode/worker-utils/managed-session-policy';

const PermissionOverridesSchema = z.intersection(
  PermissionConfigSchema,
  z.record(z.string(), z.unknown())
);

export const ManagedSessionExecutionPolicySchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z][a-z0-9-]*$/, 'Policy name must be a slug'),
    permissionOverrides: PermissionOverridesSchema.optional(),
    tools: z.record(z.string().min(1).max(100), z.boolean()).optional(),
    interaction: z
      .object({
        question: z.enum(['allow', 'deny']).optional(),
        permission: z.enum(['allow', 'auto-approve', 'auto-reject']).optional(),
        terminal: z.enum(['allow', 'deny']).optional(),
      })
      .strict()
      .optional(),
    runtime: z
      .object({
        nonInteractive: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ManagedSessionExecutionPolicy = z.infer<typeof ManagedSessionExecutionPolicySchema>;

type SessionExecutionPolicySource = {
  executionPolicy?: ManagedSessionExecutionPolicy;
  identity?: {
    createdOnPlatform?: string;
  };
};

const LegacyCodeReviewExecutionPolicy = ManagedSessionExecutionPolicySchema.parse(
  buildCodeReviewManagedSessionPolicy()
);

export function resolveSessionExecutionPolicy(
  metadata: SessionExecutionPolicySource | null | undefined
): ManagedSessionExecutionPolicy | undefined {
  if (!metadata) return undefined;
  if (metadata.executionPolicy) return metadata.executionPolicy;

  // Legacy code-review sessions predate the explicit managed-session policy.
  // Keep them constrained until their Durable Object state naturally expires.
  if (metadata.identity?.createdOnPlatform === 'code-review') {
    return LegacyCodeReviewExecutionPolicy;
  }

  return undefined;
}
