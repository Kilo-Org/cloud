import { z } from 'zod';

export const workspaceChatSchema = z.object({ transport: z.enum(['stream', 'relay']) }).strict();

export type WorkspaceChat = z.infer<typeof workspaceChatSchema>;
