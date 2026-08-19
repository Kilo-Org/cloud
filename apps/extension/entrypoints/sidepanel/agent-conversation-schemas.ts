import { z } from 'zod';
import type { WebMcpGatewayToolName } from '@/src/shared/kilo-gateway-chat-client';

const remoteMcpAgentToolNameSchema = z.templateLiteral(['mcp_', z.string()]);
const workflowToolNameSchema = z.enum([
  'delete_workflow',
  'get_workflow',
  'run_workflow',
  'save_memory',
  'save_workflow',
  'search_workflows',
]);
const genericStringSchema = z.string();

export const conversationEventSchema = z.union([
  z.object({
    id: z.string(),
    role: z.enum(['assistant', 'user']),
    systemEnvironment: z.string().optional(),
    text: z.string(),
    type: z.literal('message'),
  }),
  z.object({ id: z.string(), text: z.string(), type: z.literal('thinking') }),
  z.object({
    code: z.string(),
    id: z.string(),
    name: z.literal('eval'),
    providerToolCallId: z.string().optional(),
    tabId: z.number(),
    type: z.literal('tool-call'),
  }),
  z.object({
    elementId: z.string().optional(),
    id: z.string(),
    memoryId: z.string().optional(),
    name: z.enum([
      'find_in_page',
      'get_element_details',
      'get_memory',
      'get_page_snapshot',
      'get_viewport_screenshot',
      'search_memories',
      'web_search',
    ]),
    providerToolCallId: z.string().optional(),
    query: z.string().optional(),
    snapshotId: z.string().optional(),
    tabId: z.number(),
    textStart: z.number().optional(),
    type: z.literal('tool-call'),
  }),
  z.object({
    arguments: z.record(z.string(), z.unknown()),
    id: z.string(),
    name: remoteMcpAgentToolNameSchema,
    providerToolCallId: z.string().optional(),
    remoteToolName: z.string(),
    serverId: z.string(),
    serverName: z.string(),
    type: z.literal('tool-call'),
  }),
  z.object({
    arguments: z.record(z.string(), z.unknown()),
    id: z.string(),
    name: workflowToolNameSchema,
    providerToolCallId: z.string().optional(),
    tabId: z.number(),
    type: z.literal('tool-call'),
  }),
  z.object({
    arguments: z.record(z.string(), z.unknown()),
    definitionSignature: z.string(),
    documentId: z.string(),
    id: z.string(),
    name: z.custom<WebMcpGatewayToolName>(value => genericStringSchema.safeParse(value).success),
    providerToolCallId: z.string().optional(),
    tabId: z.number(),
    type: z.literal('tool-call'),
    webMcpOrigin: z.string(),
  }),
  z.object({
    error: z.string().optional(),
    id: z.string(),
    ok: z.boolean(),
    toolCallId: z.string(),
    type: z.literal('tool-result'),
    value: z.unknown().optional(),
  }),
]);

export const conversationEventsSchema = z.array(conversationEventSchema);

export const storedConversationSchema = z.object({
  events: conversationEventsSchema,
  id: z.string(),
  mode: z.enum(['dangerous', 'safe']).optional(),
  model: z.string().optional(),
  selectedTabId: z.number().optional(),
  thinkingEffort: z.string().optional(),
  title: z.string(),
  updatedAt: z.string().optional(),
});

export const storedConversationsSchema = z.object({
  activeConversationId: z.string(),
  conversations: z.array(storedConversationSchema),
  openConversationIds: z.array(z.string()).optional(),
});
