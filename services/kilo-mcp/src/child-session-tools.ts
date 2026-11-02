import { z } from 'zod';
import {
  cloudAgentAuthorityInputSchema,
  type CloudAgentAuthority,
} from '../../../packages/worker-utils/src/cloud-agent-authority';
import {
  assertInputMatchesSchema,
  callCatalogEndpoint,
  fetchCatalogCall,
  MAX_RESULT_BYTES,
} from './call';
import { JsonRpcFailure, type Catalog, type ForwardedAuth } from './types';

const childOperations = [
  {
    name: 'spawn_session',
    procedure: 'prepareSession',
    description:
      'Create and start an independent child Cloud Agent workspace with its own sandbox, worktree, and multi-chat support. Use only when the user explicitly asks to launch a Cloud Agent, not to explore the current worktree. First use search_models to resolve the requested model to its exact id and supported variant. Supply a complete task brief including constraints, verification, and Git/PR requirements; the parent conversation is not the task prompt. Generate one UUID operationKey for this launch and retain it for reconciliation; never replace it to retry an unknown outcome. Set callbackTarget to {"url":"session:parent"} to receive completion, failure, or interruption in the canonical parent chat; omit for no notification. Returns cloudAgentSessionId and kiloSessionId; successful creation is admission, not task completion. Organization and parent platform are inherited server-side. Children cannot spawn grandchildren.',
  },
  {
    name: 'list_child_sessions',
    procedure: 'listChildSessions',
    description:
      "List only the canonical workspace parent's direct child Cloud Agent sessions. Use to rediscover child IDs or reconcile an uncertain launch, not as a polling loop. Returns cloudAgentSessionId and, when recorded, initialMessageId and worktreeId. Pass nextCursor as cursor to read another page. Sibling chats in this workspace share the same parent and child list.",
  },
  {
    name: 'get_session',
    procedure: 'getSession',
    description:
      "Inspect one direct child Cloud Agent session and its current work. Use a cloudAgentSessionId returned by spawn_session or list_child_sessions, never a kiloSessionId or a session from another workspace. This is a bounded status check, not a wait for completion. Prefer the session:parent callback to polling; use get_message_result for a particular message's terminal outcome and assistant response.",
  },
  {
    name: 'get_message_result',
    procedure: 'getMessageResult',
    description:
      'Read the durable outcome of one message in a direct child session: queued, running, completed, failed, or interrupted, with result or failure information when available. Use initialMessageId from list_child_sessions for the initial task, or the messageId used for send_message. A missing result or queued/running status is not completion. Keep checks bounded and prefer callbacks over polling.',
  },
  {
    name: 'send_message',
    procedure: 'sendMessage',
    description:
      'Send an explicitly authorized follow-up prompt to an existing direct child, reusing its workspace and delegation. Supply payload {type:"prompt", prompt, mode, model, variant?}; resolve the exact model id and variant with search_models. Generate one canonical messageId for new work and retain that same ID when reconciling the same submission. Admission does not mean completion. Cannot run command payloads, replace runtime configuration, broaden authority, or recover expired delegation.',
  },
  {
    name: 'interrupt_session',
    procedure: 'interruptSession',
    description:
      'Request Stop for a direct child Cloud Agent session when the user authorizes interruption. Pass its cloudAgentSessionId in sessionId. This interrupts work; it does not delete the session or guarantee physical sandbox cleanup. Check durable outcomes if confirmation is needed. Never target the parent, unrelated sessions, or siblings in the parent workspace.',
  },
] as const;

const searchModelsArgs = z
  .object({
    query: z
      .string()
      .max(200)
      .optional()
      .describe(
        'Model name, provider, partial name, or exact ID, e.g. "Claude Opus" or "gpt5". Omit to browse, with preferred models first.'
      ),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strict();

const modelSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  supportsVision: z.boolean(),
  isPreferred: z.boolean(),
  variants: z.array(z.string()),
  alias_target: z.string().optional(),
});

export const CHILD_SESSION_TOOL_NAMES = [
  'search_models',
  ...childOperations.map(tool => tool.name),
];

export const CHILD_SESSION_INSTRUCTIONS =
  'This MCP connection manages direct child Cloud Agent sessions through dedicated tools, not API search/call. It belongs to the workspace\'s canonical parent session, the original root chat, not to the sibling chat that invoked this tool. Launch a child only when the user explicitly asks to spin up a new Cloud Agent session. Each child has its own sandbox and worktree with multi-chat support; use children to fan out independent tasks, not to explore or work in this worktree. First call search_models with the requested model name; copy the returned id exactly into model and use only a returned variant, passed separately. Do not guess model identifiers, silently substitute models, or treat catalog discovery as proof of organization policy approval. Call spawn_session with a complete task brief and a fresh UUID operationKey. Organization and createdOnPlatform come from trusted parent state, not caller input. Include callbackTarget: { url: "session:parent" } to receive the result as a new message in the canonical parent; omit for no notification. Prefer callbacks over polling. Do not poll or wait in a tool for a callback; keep any status check bounded. Use list_child_sessions to recover IDs, get_session for status, get_message_result for a specific message outcome, send_message for authorized follow-ups, and interrupt_session for authorized Stop. You may list, inspect, check status, stop, send a follow-up to, or spawn only direct child Cloud Agent sessions of this parent and must not access unrelated sessions. An accepted launch or follow-up is not completed work. After an ambiguous mutation failure, reconcile state before retrying and retain the original operationKey/messageId. Spawned children cannot spawn further children; do not launch a child from a child session, and do not ask a child to launch one.';

const fieldDescriptions: Record<string, string> = {
  githubRepo: 'GitHub repository in owner/repository form. The child checks it out independently.',
  model: 'Exact model id returned by search_models, not its display name or a guessed identifier.',
  variant:
    'A supported variant returned by search_models for this exact model. Omit if not requested; do not put it in the model ID.',
  prompt:
    'Complete independent task brief: goal, relevant context, constraints, required verification, Git/PR instructions, and expected report.',
  mode: 'Agent mode for the task, usually code for implementation or plan for planning.',
  operationKey:
    'A fresh UUID for this launch. Keep this value and the same task input when reconciling or retrying the same launch; do not generate a replacement after a timeout.',
  autoCommit:
    'Whether automatic finalization may commit and push changes. Set false when the user forbids publication. PR creation must be requested in the task prompt.',
  upstreamBranch: 'Repository branch to start from; omit to use the repository default.',
  callbackTarget:
    'Set {"url":"session:parent"} for completion/failure/interruption notification in the canonical parent chat. Omit for no callback.',
  cloudAgentSessionId:
    'The workspace_* child session ID from spawn_session or list_child_sessions, not kiloSessionId.',
  sessionId: 'The workspace_* child cloudAgentSessionId to interrupt, not kiloSessionId.',
  messageId:
    'Canonical message ID matching msg_[12 lowercase hex][14 alphanumeric]. For a new follow-up generate a fresh ID; reuse it only for that same submission. For a result use initialMessageId or the submitted follow-up ID.',
  expectedWorktreeId:
    'Optional worktree_* ID from list_child_sessions to verify the child workspace binding.',
  cursor: 'nextCursor returned by the previous list_child_sessions page.',
  limit: 'Maximum children per page, from 1 to 50; defaults to 20.',
  payload:
    'Follow-up prompt and agent settings: {type:"prompt", prompt, mode, model, variant?}. model must be an exact id from search_models.',
};

export function childSessionTools(authority: CloudAgentAuthority) {
  const prefix =
    authority.organizationId === null ? 'cloudAgentNext' : 'organizations.cloudAgentNext';
  return [
    {
      name: 'search_models',
      description:
        'Find model identifiers and supported reasoning variants before spawning a child or changing its model. Searches the current model catalog by human name, provider, partial name, or exact ID, ignoring case, spacing, and punctuation. Returns id, name, variants, isPreferred, supportsVision, and alias_target when present. Copy id exactly to model and pass a supported variant separately; never invent either. Omit query to browse preferred models first. hasMore means narrow the query or increase limit (maximum 20). Multiple matches are candidates, not a selection; do not silently substitute a different requested model. An empty variants list means no named variants are advertised. Catalog identity does not guarantee organization policy approval at launch.',
      inputSchema: z.toJSONSchema(searchModelsArgs, { io: 'input' }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    ...childOperations.map(tool => {
      const schema = cloudAgentAuthorityInputSchema(authority, `${prefix}.${tool.procedure}`);
      const properties = { ...(schema.properties as Record<string, Record<string, unknown>>) };
      delete properties.organizationId;
      delete properties.autoInitiate;
      for (const [key, property] of Object.entries(properties)) {
        properties[key] = {
          ...property,
          description: fieldDescriptions[key] ?? property.description,
        };
      }
      const required = Array.isArray(schema.required)
        ? schema.required.filter(key => key !== 'organizationId' && key !== 'autoInitiate')
        : [];
      if (tool.procedure === 'prepareSession') required.push('operationKey');
      const readOnly = ['listChildSessions', 'getSession', 'getMessageResult'].includes(
        tool.procedure
      );
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: { ...schema, properties, required },
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: tool.procedure === 'interruptSession',
          idempotentHint: readOnly,
          openWorldHint: true,
        },
      };
    }),
  ];
}

export async function runChildSessionTool(options: {
  name: string;
  args: Record<string, unknown>;
  auth: ForwardedAuth;
  catalog: Catalog;
  webBaseUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<{ text: string; truncated: boolean }> {
  const { name, args, auth, catalog } = options;
  const authority = auth.cloudAgentAuthority;
  if (!authority || !CHILD_SESSION_TOOL_NAMES.includes(name)) {
    throw new JsonRpcFailure(
      -32602,
      `Unknown tool "${name}". Available tools: ${CHILD_SESSION_TOOL_NAMES.join(', ')}.`
    );
  }
  if (name === 'search_models') {
    const parsedArgs = searchModelsArgs.safeParse(args);
    if (!parsedArgs.success)
      throw new JsonRpcFailure(
        -32602,
        'Invalid search_models arguments: use an optional query and a limit from 1 to 20.'
      );
    const row = catalog['models.list'];
    if (!row || row.kind !== 'query' || row.admin || row.debug) {
      throw new JsonRpcFailure(-32000, 'Model discovery is unavailable in the Kilo catalog.');
    }
    const data = await fetchCatalogCall({ ...options, row, input: undefined });
    const parsedModels = z.array(modelSchema).safeParse(data);
    if (!parsedModels.success)
      throw new JsonRpcFailure(-32000, 'The Kilo API returned an invalid model catalog.');
    const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
    const query = parsedArgs.data.query?.trim().toLowerCase() ?? '';
    const tokens = query.split(/\s+/).map(normalize).filter(Boolean);
    const rank = (model: z.infer<typeof modelSchema>) =>
      model.id.toLowerCase() === query
        ? 0
        : model.name.toLowerCase() === query
          ? 1
          : normalize(model.id) === normalize(query)
            ? 2
            : 3;
    const matches = parsedModels.data
      .filter(model =>
        tokens.every(token => normalize(`${model.id} ${model.name}`).includes(token))
      )
      .sort(
        (a, b) =>
          rank(a) - rank(b) ||
          Number(b.isPreferred) - Number(a.isPreferred) ||
          a.id.localeCompare(b.id)
      );
    const models = matches.slice(0, parsedArgs.data.limit);
    let text = JSON.stringify({ models, hasMore: matches.length > models.length });
    while (new TextEncoder().encode(text).byteLength > MAX_RESULT_BYTES && models.length > 0) {
      models.pop();
      text = JSON.stringify({ models, hasMore: true });
    }
    return { text, truncated: models.length < Math.min(matches.length, parsedArgs.data.limit) };
  }
  const operation = childOperations.find(tool => tool.name === name);
  const tool = childSessionTools(authority).find(tool => tool.name === name);
  if (!operation || !tool) throw new JsonRpcFailure(-32602, 'Unknown child session tool.');
  const prefix =
    authority.organizationId === null ? 'cloudAgentNext' : 'organizations.cloudAgentNext';
  const path = `${prefix}.${operation.procedure}`;
  const row = catalog[path];
  if (!row)
    throw new JsonRpcFailure(-32000, 'Child session operation is unavailable in the Kilo catalog.');
  assertInputMatchesSchema({ ...row, inputSchema: tool.inputSchema }, name, args);
  return callCatalogEndpoint({
    ...options,
    path,
    input: {
      ...args,
      ...(operation.procedure === 'prepareSession' ? { autoInitiate: true } : {}),
      ...(authority.organizationId === null ? {} : { organizationId: authority.organizationId }),
    },
  });
}
