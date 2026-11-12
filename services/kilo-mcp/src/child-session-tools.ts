import { z } from 'zod';
import {
  buildMessageId,
  MESSAGE_ID_RANDOM_LENGTH,
} from '../../../packages/session-ingest-contracts/src/message-id';
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
    name: 'list_environments',
    procedure: 'cloudEnvironments.list',
    description:
      'List the Cloud Agent repository environments configured for one GitHub repository in the parent\'s fixed personal or organization scope. Pass repository as {platform:"github",fullName:"owner/repo"}. Returns environment summaries with id, name, repository identity, and configuration counts; pass a returned id as requestedEnvironment.id to spawn_session. This is read-only: it returns environments only for the requested repository and cannot list environments across repositories, get one by id, or create, update, or delete anything.',
  },
  {
    name: 'spawn_session',
    procedure: 'prepareSession',
    description:
      'Create and start an independent child Cloud Agent workspace with its own sandbox, worktree, and multi-chat support. Use only when the user explicitly asks to launch a Cloud Agent, not to explore the current worktree. First use search_models to resolve the requested model to its exact id and supported variant. If the user selected a repository environment, call list_environments for the launch repository and pass the returned id as requestedEnvironment {id}; for an additional repository of a multi-repository environment, include {repoFullName,branch} in requestedEnvironment.repositories. Omit requestedEnvironment to leave environment selection to the server\'s automatic/default behavior. Supply a complete task brief including constraints, verification, and Git/PR requirements; the parent conversation is not the task prompt. Generate one UUID operationKey for this launch and retain it for reconciliation; never replace it to retry an unknown outcome. Set callbackTarget to {"url":"workspace:new-chat"} to open a new chat in the parent workspace with the result as its first message, or to {"url":"workspace:<session-id>"} using the session id from the cloud-agent-context to notify this chat; omit for no notification. Returns cloudAgentSessionId, kiloSessionId, and worktreeId; successful creation is admission, not task completion. To stack this child on the pushed branch of a direct child, set stackOnWorktreeId to that worktreeId. Organization and parent platform are inherited server-side. Children cannot spawn grandchildren.',
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
      "Inspect one direct child Cloud Agent session and its current work. Use a cloudAgentSessionId returned by spawn_session or list_child_sessions, never a kiloSessionId or a session from another workspace. This is a bounded status check, not a wait for completion. Prefer a completion callback to polling; use get_message_result for a particular message's terminal outcome and assistant response.",
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
      'Send an explicitly authorized follow-up prompt to an existing direct child, reusing its workspace and delegation. Supply payload {type:"prompt", prompt, mode, model, variant?}; resolve the exact model id and variant with search_models. First call generate_message_id with {} and copy its returned messageId; retain that same ID when reconciling or retrying the same submission. Do not generate another ID after an uncertain send. Automatic commit/push is not requested when autoCommit is omitted and does not inherit a previous message setting. Admission does not mean completion. Cannot run command payloads, replace runtime configuration, broaden authority, or recover expired delegation.',
  },
  {
    name: 'interrupt_session',
    procedure: 'interruptSession',
    description:
      'Request Stop for a direct child Cloud Agent session when the user authorizes interruption. Pass its cloudAgentSessionId in sessionId. This interrupts work; it does not delete the session or guarantee physical sandbox cleanup. Check durable outcomes if confirmation is needed. Never target the parent, unrelated sessions, or siblings in the parent workspace.',
  },
  {
    name: 'list_folders',
    procedure: 'workspaceFolders.list',
    description:
      "List existing workspace folders belonging to this user in the parent's fixed personal or organization scope. Returns folder id, name, and color; worktreeIds is intentionally empty and does not describe folder membership. Use the returned folder id with assign_workspace_to_folder to organize a workspace this parent created. Does not list unrelated workspaces or grant permission to create, rename, delete, or reorder folders. A revoked parent or unavailable authorization fails rather than appearing as an empty folder list.",
  },
  {
    name: 'assign_workspace_to_folder',
    procedure: 'workspaceFolders.moveWorktree',
    description:
      'Assign a workspace created by this canonical parent to an existing folder in the same user and organization scope, or pass folderId:null to remove its folder assignment. Use list_folders for the exact folder id and list_child_sessions or get_session for the child cloudAgentSessionId and worktreeId. Both child and worktree IDs are required and verified against live parent authorization, direct-child lineage, and stored workspace ownership. The folder applies to the entire worktree, including all sibling chats, without changing chat activity or runtime state. Cannot move the parent workspace or other workspaces owned by the same user. After a transport failure, reconcile before retrying.',
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

const generateMessageIdArgs = z.object({}).strict();

export const CHILD_SESSION_TOOL_NAMES = [
  'search_models',
  'generate_message_id',
  ...childOperations.map(tool => tool.name),
];

export const CHILD_SESSION_INSTRUCTIONS = [
  "This MCP connection manages direct child Cloud Agent sessions through dedicated tools, not API search/call. It belongs to the workspace's canonical parent session, the original root chat, not to the sibling chat that invoked this tool.",
  'Launch a child only when the user explicitly asks to spin up a new Cloud Agent session or stacked PRs. A request to split work into stacked PRs permits the required stacked workspaces. Each child has its own sandbox and worktree with multi-chat support; use children to fan out independent tasks, not to explore or work in this worktree.',
  'First call search_models with the requested model name; copy the returned id exactly into model and use only a returned variant, passed separately. If no model was requested, use an already-established user preference and resolve it with search_models; otherwise browse search_models with {} and ask the user to choose. There is no implicit model default; isPreferred is a recommendation, not a selected account default. Omit variant unless requested. Do not guess model identifiers, silently substitute models, or treat catalog discovery as proof of organization policy approval.',
  'Call spawn_session with a complete task brief and a fresh UUID operationKey. To use a repository environment, first call list_environments with {repository:{platform:"github",fullName:"owner/repo"}} and pass a returned id as requestedEnvironment {id}; include requestedEnvironment.repositories for additional repositories of a multi-repository environment. Omit requestedEnvironment to leave environment selection to the server\'s automatic/default behavior. Organization and createdOnPlatform come from trusted parent state, not caller input. Automatic commit/push is not requested when autoCommit is omitted; set true explicitly on the launch and each follow-up where authorized, because follow-ups do not inherit it. When publication is forbidden, set false and also forbid commit/push/PR actions in the task prompt; false alone does not restrict the child agent\'s Git tools. PR creation must be requested in the task prompt.',
  'For an orchestrated stack, spawn worker A without stackOnWorktreeId and save its returned worktreeId and session IDs. Wait for A to commit and push its branch. Then spawn worker B with stackOnWorktreeId set to A.worktreeId and the same githubRepo. Repeat with each returned worktreeId for later layers. Stack only on a direct child of this parent. Omit upstreamBranch for stacked launches: it checks out that branch instead of creating a new branch on top. Tell the child to open its PR against the parent branch; the platform also supplies that base instruction. This parent launches every layer, and its callback target stays the orchestrator even when the stack parent is another worker.',
  'Include callbackTarget: { url: "workspace:new-chat" } to create a new chat in the parent workspace with the result as its first message, or callbackTarget: { url: "workspace:<session-id>" } using the cloud-agent-context session id to notify this chat; omit for no notification. Prefer callbacks over polling. Do not poll or wait in a tool for a callback; keep any status check bounded.',
  'Use list_child_sessions to recover IDs, get_session for status, get_message_result for a specific message outcome, send_message for authorized follow-ups, and interrupt_session for authorized Stop. Before each new follow-up, call generate_message_id with {} and copy the returned messageId into send_message; this only generates an ID and does not send work. Keep that ID for reconciliation and retries of the same submission; never generate a replacement after an uncertain send. For the initial task, use initialMessageId from list_child_sessions when recorded; if absent, report the missing ID rather than generating a replacement.',
  "Use list_folders to discover existing folder IDs in the fixed parent scope, then assign_workspace_to_folder with the direct child's cloudAgentSessionId and worktreeId to file its entire workspace; folderId:null removes the assignment. Folder tools cannot organize unrelated workspaces or create, edit, delete, or reorder folders.",
  'You may list, inspect, check status, stop, send a follow-up to, or spawn only direct child Cloud Agent sessions of this parent and must not access unrelated sessions. An accepted launch or follow-up is not completed work. After an ambiguous mutation failure, reconcile state before retrying and retain the original operationKey/messageId. Spawned children cannot spawn further children; do not launch a child from a child session, and do not ask a child to launch one.',
  'Example launch sequence: search_models({query: requestedModel}), select the exact returned model.id, then spawn_session({githubRepo:"owner/repo",model:model.id,mode:"code",prompt:"Fix the bug, run focused tests, and report results. Do not commit, push, or create a PR.",operationKey:freshUuid,autoCommit:false,callbackTarget:{url:"workspace:new-chat"}}). After the callback, use list_child_sessions to find this child\'s initialMessageId and get_message_result({cloudAgentSessionId:child.cloudAgentSessionId,messageId:child.initialMessageId}).',
  'Example follow-up sequence: generate_message_id({}) returns {messageId}; send_message({cloudAgentSessionId:child.cloudAgentSessionId,messageId,payload:{type:"prompt",prompt:"Run the additional authorized checks and report results. Do not commit, push, or create a PR.",mode:"code",model:model.id},autoCommit:false}); after the callback, or as one bounded check, get_message_result({cloudAgentSessionId:child.cloudAgentSessionId,messageId}) reads that exact message\'s outcome. Do not interpret queued/running or a missing result as completion.',
].join(' ');

const fieldDescriptions: Record<string, string> = {
  githubRepo: 'GitHub repository in owner/repository form. The child checks it out independently.',
  model:
    'Required exact model id returned by search_models. No implicit default: resolve an established user preference, or ask the user to choose. isPreferred is not an account default.',
  variant:
    'A supported variant returned by search_models for this exact model. Omit if not requested; do not put it in the model ID.',
  prompt:
    'Complete independent task brief: goal, relevant context, constraints, required verification, Git/PR instructions, and expected report.',
  mode: 'Agent mode for the task, usually code for implementation or plan for planning.',
  operationKey:
    'A fresh UUID for this launch. Keep this value and the same task input when reconciling or retrying the same launch; do not generate a replacement after a timeout.',
  autoCommit:
    "Whether this message requests automatic commit/push on finalization. Omitted means no request; follow-ups do not inherit the earlier setting. Set true only when authorized. If publication is forbidden, set false and forbid commit/push/PR actions in the prompt too; false does not restrict agent Git tools or cancel another prompt's request. PR creation must be requested in the prompt.",
  upstreamBranch: 'Repository branch to start from; omit to use the repository default.',
  requestedEnvironment:
    "Repository environment the user selected, discovered with list_environments for the launch repository. Pass its id; include repositories with repoFullName and optional branch for each additional repository of a multi-repository environment. Omit to leave environment selection to the server's automatic/default behavior.",
  repository:
    'GitHub repository identity in {platform:"github",fullName:"owner/repo"} form. Spawn currently supports only GitHub repositories, so this is the launch repository whose environments to list.',
  stackOnWorktreeId:
    "The worktree_* ID of a direct child from spawn_session or list_child_sessions. The new child starts a branch on top of that child's pushed branch. Omit upstreamBranch when set.",
  callbackTarget:
    'Set {"url":"workspace:new-chat"} to open a new chat in the parent workspace with the result as its first message, or {"url":"workspace:<session-id>"} using the cloud-agent-context session id to notify this chat. Omit for no callback.',
  cloudAgentSessionId:
    'The workspace_* child session ID from spawn_session or list_child_sessions, not kiloSessionId.',
  sessionId: 'The workspace_* child cloudAgentSessionId to interrupt, not kiloSessionId.',
  messageId:
    'For a new follow-up, call generate_message_id with {} and copy its returned messageId. Retain that same ID for reconciliation/retries; never generate another after an uncertain send. For a result use initialMessageId or the submitted follow-up ID.',
  expectedWorktreeId:
    'Optional worktree_* ID from list_child_sessions to verify the child workspace binding.',
  worktreeId:
    "The child workspace's worktree_* ID from list_child_sessions or get_session. It must match the supplied direct child cloudAgentSessionId.",
  folderId:
    "Existing folder UUID returned by list_folders in this parent's fixed account scope, or null to remove the child workspace's folder assignment.",
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
        'Find model identifiers and supported reasoning variants before spawning a child or changing its model. Searches the current model catalog by human name, provider, partial name, or exact ID, ignoring case, spacing, and punctuation. Returns id, name, variants, isPreferred, supportsVision, and alias_target when present. Copy id exactly to model and pass a supported variant separately; never invent either. Omit query to browse preferred models first. No implicit model default: if the user omitted a model, resolve an established user preference or ask them to choose. isPreferred is a recommendation, not a selected account default. Omit variant unless requested. hasMore means narrow the query or increase limit (maximum 20). Multiple matches are candidates, not a selection; do not silently substitute a different requested model. An empty variants list means no named variants are advertised. Catalog identity does not guarantee organization policy approval at launch.',
      inputSchema: z.toJSONSchema(searchModelsArgs, { io: 'input' }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    {
      name: 'generate_message_id',
      description:
        'Generate a fresh canonical message ID for one new authorized send_message follow-up. Call with {} and copy the returned {messageId}; do not construct IDs yourself. Each call returns a new ID without creating a session, reserving a message, or sending work. Retain the ID before sending and reuse it for reconciliation/retries of that same submission; never generate a replacement after an uncertain send. Initial task IDs come from list_child_sessions.initialMessageId instead. This is not the UUID operationKey used for a launch.',
      inputSchema: z.toJSONSchema(generateMessageIdArgs, { io: 'input' }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    ...childOperations.map(tool => {
      const path =
        tool.procedure === 'cloudEnvironments.list' ||
        tool.procedure.startsWith('workspaceFolders.')
          ? tool.procedure
          : `${prefix}.${tool.procedure}`;
      const schema = cloudAgentAuthorityInputSchema(authority, path);
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
      const readOnly = [
        'listChildSessions',
        'getSession',
        'getMessageResult',
        'workspaceFolders.list',
        'cloudEnvironments.list',
      ].includes(tool.procedure);
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
  if (
    authority.ownerId !== auth.kiloUserId ||
    authority.organizationId !== (auth.organizationId ?? null) ||
    authority.expiresAt <= Math.floor(Date.now() / 1000)
  ) {
    throw new JsonRpcFailure(-32602, 'Cloud Agent authority does not permit this request');
  }
  if (name === 'generate_message_id') {
    if (!generateMessageIdArgs.safeParse(args).success) {
      throw new JsonRpcFailure(-32602, 'Invalid generate_message_id arguments: pass an empty {}.');
    }
    const messageId = buildMessageId(
      Date.now(),
      crypto.getRandomValues(new Uint8Array(MESSAGE_ID_RANDOM_LENGTH))
    );
    return { text: JSON.stringify({ messageId }), truncated: false };
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
  const folderOperation = operation.procedure.startsWith('workspaceFolders.');
  const path =
    operation.procedure === 'cloudEnvironments.list' || folderOperation
      ? operation.procedure
      : `${prefix}.${operation.procedure}`;
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
      ...(authority.organizationId === null && !folderOperation
        ? {}
        : { organizationId: authority.organizationId }),
    },
  });
}
