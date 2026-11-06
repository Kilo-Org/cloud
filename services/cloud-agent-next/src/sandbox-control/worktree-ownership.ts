import { z } from 'zod';
import {
  cloudAgentWorktreeIdSchema,
  cloudAgentWorktreeLocationSchema,
  sessionIdSchema,
} from '@kilocode/session-ingest-contracts';
import { getSandboxProvider, type SessionMetadata } from '../persistence/session-metadata';

export const sessionRuntimeLocatorSchema = z
  .object({
    cloudAgentSessionId: z.string().min(1),
    kiloUserId: z.string().min(1),
    organizationId: z.uuid().nullable(),
    sessionId: sessionIdSchema.nullable(),
    worktreeId: cloudAgentWorktreeIdSchema.nullable(),
    location: cloudAgentWorktreeLocationSchema,
  })
  .strict();
export type SessionRuntimeLocator = z.infer<typeof sessionRuntimeLocatorSchema>;

export function sessionRuntimeLocator(metadata: SessionMetadata): SessionRuntimeLocator | null {
  if (!metadata.workspace?.sandboxId) return null;
  return sessionRuntimeLocatorSchema.parse({
    cloudAgentSessionId: metadata.identity.sessionId,
    kiloUserId: metadata.identity.userId,
    organizationId: metadata.identity.orgId ?? null,
    sessionId: metadata.auth.kiloSessionId ?? null,
    worktreeId: metadata.workspace.worktreeId ?? null,
    location: { sandboxId: metadata.workspace.sandboxId, provider: getSandboxProvider(metadata) },
  });
}
