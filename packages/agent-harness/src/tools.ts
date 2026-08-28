import { z } from 'zod';
import type { ToolCall } from './contracts';

const Id = z.uuid();
const Text = z
  .string()
  .min(1)
  .refine(value => value.trim().length > 0);
const Empty = z.strictObject({});
const JsonObject = z.record(z.string(), z.json());
const Session = z.strictObject({ sessionId: Text });
const Resource = z.strictObject({ id: Text, name: Text });
const HttpUrl = z.url({ protocol: /^https?$/ });
const Page = z.strictObject({
  url: HttpUrl,
  title: Text,
  text: z.string(),
  publishedAt: z.iso.datetime().optional(),
  untrusted: z.literal(true),
});
export const ScreenSchema = z.discriminatedUnion('screen', [
  z.strictObject({ screen: z.literal(['quickChat', 'organizationMembers', 'preferences']) }),
  z.strictObject({ screen: z.literal('session'), sessionId: Text }),
]);
const Preference = z.strictObject({
  name: z.enum(['showToolDetails', 'reasoningDefaultExpanded']),
  value: z.boolean(),
});
const NotificationState = z.strictObject({
  permission: z.enum(['granted', 'denied', 'undetermined', 'unavailable']),
});
export const QuestionSchema = z
  .strictObject({
    questionId: Text,
    prompt: Text,
    choices: z.array(z.strictObject({ id: Text, label: Text })),
    minSelections: z.int().nonnegative(),
    maxSelections: z.int().nonnegative(),
    allowFreeText: z.boolean().default(false),
    allowCancellation: z.boolean(),
  })
  .refine(
    q =>
      new Set(q.choices.map(choice => choice.id)).size === q.choices.length &&
      q.minSelections <= q.maxSelections &&
      q.maxSelections <= q.choices.length &&
      (q.maxSelections > 0 || q.allowFreeText || q.allowCancellation)
  );
export const QuestionResponseSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('answer'),
    questionId: Text,
    choiceIds: z.array(Text).refine(ids => new Set(ids).size === ids.length),
    text: Text.optional(),
  }),
  z.strictObject({ kind: z.literal('dismiss'), questionId: Text }),
]);
export function validQuestionResponse(question: unknown, response: unknown): boolean {
  const q = QuestionSchema.safeParse(question);
  const r = QuestionResponseSchema.safeParse(response);
  if (!q.success || !r.success || q.data.questionId !== r.data.questionId) return false;
  if (r.data.kind === 'dismiss') return q.data.allowCancellation;
  const answer = r.data;
  return (
    answer.choiceIds.length >= q.data.minSelections &&
    answer.choiceIds.length <= q.data.maxSelections &&
    answer.choiceIds.every(id => q.data.choices.some(choice => choice.id === id)) &&
    (answer.text === undefined || q.data.allowFreeText) &&
    (q.data.maxSelections > 0 || answer.text !== undefined)
  );
}

function defineTool<const N extends string, I extends z.ZodType, O extends z.ZodType>(
  name: N,
  group: 'kilo' | 'mcp' | 'web' | 'app' | 'question',
  effect: ToolCall['effect'],
  executorKind: ToolCall['executionTarget']['kind'],
  inputSchema: I,
  outputSchema: O
) {
  return {
    name,
    version: '1',
    group,
    effect,
    executorKind,
    inputSchema,
    outputSchema,
    requestSchema: z.strictObject({ name: z.literal(name), arguments: inputSchema }),
  };
}
const Invite = z.strictObject({ recipient: z.email(), role: Text });
const Start = z.strictObject({ prompt: Text, modelId: Text, repository: Text.optional() });
const Continue = Session.extend({ message: Text });
const Attachment = Session.extend({
  messages: z.array(z.strictObject({ role: z.enum(['user', 'assistant']), content: z.string() })),
  untrusted: z.literal(true),
});
const RemoteDefinition = z.strictObject({
  serverId: Text,
  configurationVersion: Text,
  name: Text,
  definitionVersion: Text,
  inputSchema: JsonObject,
  outputSchema: JsonObject,
});
const RemoteCall = RemoteDefinition.omit({ inputSchema: true, outputSchema: true }).extend({
  arguments: JsonObject,
});
const RemoteOutput = z.strictObject({
  content: z.array(JsonObject),
  structuredContent: JsonObject.optional(),
});

// Definitions describe contracts only. The backend advertises a tool only after installing its executor.
export const toolDefinitions = [
  defineTool('kilo.organizations', 'kilo', 'read', 'backend', Empty, z.array(Resource)),
  defineTool(
    'kilo.members',
    'kilo',
    'read',
    'backend',
    Empty,
    z.array(z.strictObject({ id: Text, email: z.email(), role: Text }))
  ),
  defineTool('kilo.usage', 'kilo', 'read', 'backend', Empty, JsonObject),
  defineTool('kilo.repositories', 'kilo', 'read', 'backend', Empty, z.array(Resource)),
  defineTool(
    'kilo.invite',
    'kilo',
    'side_effect',
    'backend',
    Invite,
    z.strictObject({ invitationId: Id, emailQueued: z.literal(true) })
  ),
  defineTool(
    'kilo.sessions.search',
    'kilo',
    'read',
    'backend',
    z.strictObject({ query: Text }),
    z.array(Session.extend({ title: Text }))
  ),
  defineTool('kilo.sessions.attach', 'kilo', 'read', 'backend', Session, Attachment),
  defineTool('kilo.sessions.start', 'kilo', 'side_effect', 'backend', Start, Session),
  defineTool('kilo.sessions.continue', 'kilo', 'side_effect', 'backend', Continue, Session),
  defineTool('kilo.sessions.stop', 'kilo', 'side_effect', 'backend', Session, Session),
  defineTool(
    'kilo.sessions.progress',
    'kilo',
    'read',
    'backend',
    Session,
    Session.extend({ status: Text })
  ),
  defineTool('mcp.discover', 'mcp', 'read', 'backend', Empty, z.array(RemoteDefinition)),
  defineTool('mcp.call', 'mcp', 'unknown', 'backend', RemoteCall, RemoteOutput),
  defineTool(
    'web.search',
    'web',
    'read',
    'backend',
    z.strictObject({ query: Text, limit: z.int().min(1).max(5).default(5) }),
    z.array(Page)
  ),
  defineTool('web.retrieve', 'web', 'read', 'backend', z.strictObject({ url: HttpUrl }), Page),
  defineTool(
    'app.currentScreen',
    'app',
    'read',
    'client',
    Empty,
    z.strictObject({ destination: ScreenSchema, data: JsonObject })
  ),
  defineTool('app.openScreen', 'app', 'side_effect', 'client', ScreenSchema, ScreenSchema),
  defineTool('app.setPreference', 'app', 'side_effect', 'client', Preference, Preference),
  defineTool('app.notifications', 'app', 'side_effect', 'client', Empty, NotificationState),
  defineTool(
    'app.openSettings',
    'app',
    'side_effect',
    'client',
    Empty,
    z.strictObject({ opened: z.boolean() })
  ),
  defineTool(
    'question.ask',
    'question',
    'read',
    'interaction',
    QuestionSchema,
    QuestionResponseSchema
  ),
] as const;
export const ToolNameSchema = z.enum(toolDefinitions.map(tool => tool.name));
const [firstTool, ...remainingTools] = toolDefinitions;
export const ToolRequestSchema = z.discriminatedUnion('name', [
  firstTool.requestSchema,
  ...remainingTools.map(tool => tool.requestSchema),
]);
export type ToolName = z.infer<typeof ToolNameSchema>;
export type ToolRequest = z.infer<typeof ToolRequestSchema>;
