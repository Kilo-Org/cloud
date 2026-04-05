import { z } from 'zod';
import { SessionItemSchema } from './session-sync';

export const sessionIdSchema = z.string().startsWith('ses_').length(30);

export const CLIWebSocketMessageSchema = z.object({
  type: z.literal('ingest'),
  sessionId: sessionIdSchema,
  data: z.array(SessionItemSchema),
});

export const ServerToWebMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('catch_up'),
    items: z.array(
      z.object({
        sessionId: z.string(),
        itemId: z.string(),
        itemType: z.string(),
        itemData: z.string(),
      })
    ),
  }),
  z.object({
    type: z.literal('events'),
    sessionId: sessionIdSchema,
    data: z.array(SessionItemSchema),
  }),
  z.object({
    type: z.literal('cli_status'),
    connected: z.boolean(),
  }),
]);

export const WebToServerMessageSchema = z.object({
  type: z.literal('command'),
  command: z.string().min(1),
  data: z.unknown(),
});

export const ServerToCLIMessageSchema = z.object({
  type: z.literal('command'),
  command: z.string().min(1),
  data: z.unknown(),
});

export type CLIWebSocketMessage = z.infer<typeof CLIWebSocketMessageSchema>;
export type ServerToWebMessage = z.infer<typeof ServerToWebMessageSchema>;
export type WebToServerMessage = z.infer<typeof WebToServerMessageSchema>;
export type ServerToCLIMessage = z.infer<typeof ServerToCLIMessageSchema>;
