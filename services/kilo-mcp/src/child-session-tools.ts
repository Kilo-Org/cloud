import { z } from 'zod';
import {
  buildMessageId,
  MESSAGE_ID_RANDOM_LENGTH,
} from '../../../packages/session-ingest-contracts/src/message-id';
import {
  cloudAgentAuthorityInputSchema,
  cloudAgentAuthorityProcedureKind,
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
    name: 'get_session_messages',
    procedure: 'getSessionMessagesPage',
    description:
      'Read a child transcript. Results are capped at 16 KiB; use a small limit, toolDisplay: "preview", and the returned cursor for older messages.',
  },
  {
    name: 'get_tool_part_detail',
    procedure: 'getSessionToolPartDetail',
    description: 'Read one tool call from the child transcript. Results are capped at 16 KiB.',
  },
  {
    name: 'get_pending_questions',
    procedure: 'getPendingInteractions',
    description: 'List the questions this child is waiting on.',
  },
  {
    name: 'answer_question',
    procedure: 'answerQuestion',
    description:
      'Answer a pending child question. Supply an array of selected answers for each question, in order.',
  },
  {
    name: 'reject_question',
    procedure: 'rejectQuestion',
    description: 'Dismiss a pending child question without answering it.',
  },
  {
    name: 'list_child_artifacts',
    procedure: 'listWorkspaceArtifacts',
    description: 'List files in the child workspace’s artifact store, shared by its chats.',
  },
  {
    name: 'get_child_artifact_url',
    procedure: 'getWorkspaceArtifactDownloadUrl',
    description:
      'Get a five-minute download URL for a child artifact. Download it from your sandbox.',
  },
  {
    name: 'cancel_queued_message',
    procedure: 'cancelQueuedMessage',
    description:
      'Cancel a queued message by its submitted ID. An active or already settled message returns dropped: false.',
  },
  {
    name: 'create_child_chat',
    procedure: 'createWorktreeChat',
    description:
      'Create a manageable child chat in an existing child workspace. It starts no turn; use send_message.',
  },
  {
    name: 'sync_child_branch',
    procedure: 'syncWorktreeBranch',
    description:
      'Sync the child branch with its remote. If worktree_operation_outcome_unknown occurs, check the branch before retrying.',
  },
  {
    name: 'restack_child_branch',
    procedure: 'restackWorktreeBranch',
    description:
      'Rebase and push the child branch onto its server-resolved base. Do not retry worktree_operation_outcome_unknown without checking the branch.',
  },
  {
    name: 'list_branches',
    procedure: 'listRepositoryBranches',
    description: 'List branches of a repository in the current account scope.',
  },
  {
    name: 'create_attachment_upload',
    procedure: 'getAttachmentUploadUrl',
    description:
      'Reserve a file and get a signed URL. PUT the bytes with the same content type and length, then pass the returned attachments to spawn_session or send_message.',
  },
  {
    name: 'release_pending_uploads',
    procedure: 'releasePendingUploads',
    description: 'Release abandoned pending uploads by their returned object keys.',
  },
  {
    name: 'list_environments',
    procedure: 'cloudEnvironments.list',
    description:
      'List environments for one repository. Use a returned ID as requestedEnvironment.id.',
  },
  {
    name: 'spawn_session',
    procedure: 'prepareSession',
    description:
      'Create and start an independent child workspace from exactly one repository source or stack target. Supply a self-contained task with constraints, verification, and Git instructions.',
  },
  {
    name: 'list_child_sessions',
    procedure: 'listChildSessions',
    description:
      'Recover child session, worktree, and initial message IDs. Use nextCursor to read another page.',
  },
  {
    name: 'get_session',
    procedure: 'getSession',
    description: 'Inspect a child session and its current work without waiting.',
  },
  {
    name: 'get_message_result',
    procedure: 'getMessageResult',
    description:
      'Read one message outcome and any retained result. Use the initialMessageId or the submitted follow-up ID.',
  },
  {
    name: 'send_message',
    procedure: 'sendMessage',
    description:
      'Send a follow-up prompt. Generate its ID with generate_message_id before submission.',
  },
  {
    name: 'interrupt_session',
    procedure: 'interruptSession',
    description: 'Stop work in a child session without deleting the session or workspace.',
  },
  {
    name: 'list_folders',
    procedure: 'workspaceFolders.list',
    description:
      'List existing folders in this account scope. This does not list folder membership.',
  },
  {
    name: 'assign_workspace_to_folder',
    procedure: 'workspaceFolders.moveWorktree',
    description:
      'Assign a child workspace and its chats to an existing folder, or use folderId: null to unfile it.',
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
  'list_repositories',
  ...childOperations.map(tool => tool.name),
];

export const CHILD_SESSION_INSTRUCTIONS =
  'This connection belongs to the workspace and manages only its direct children. Each child can manage its own children. Keep the original operationKey and messageId for retries of the same submission. If a mutation outcome is unknown, check recorded state before retrying. Prefer callbacks over polling. Acceptance is not completion.';

const fieldDescriptions: Record<string, string> = {
  githubRepo: 'GitHub repository in owner/repository form.',
  gitlabProject: 'GitLab project path, including its namespace and any subgroups.',
  operationKey: 'Use a fresh UUID for each new create request.',
  autoCommit:
    'Request automatic commit and push for this message only. To forbid publication, say so in the prompt; false does not restrict Git tools.',
  requestedEnvironment:
    'Include repositories only to select branches for additional repositories in the environment.',
  stackOnWorktreeId: 'Use your own or a direct child’s worktree ID after its branch is pushed.',
  callbackTarget:
    'Use {"url":"workspace:<session-id>"} with the cloud-agent-context ID to notify this chat. If the parent has a worktree, workspace:new-chat sends results to a new chat; set launchingSessionId to route questions here.',
  sessionId: 'The workspace_* child session ID, not kiloSessionId.',
  messageUuid: 'Use one new UUID as the upload group for all files attached to the same prompt.',
  attachmentId: 'Use a different UUID for each file.',
};

export function childSessionTools(authority: CloudAgentAuthority) {
  const prefix =
    authority.organizationId === null ? 'cloudAgentNext' : 'organizations.cloudAgentNext';
  return [
    {
      name: 'list_repositories',
      description: 'List repositories available from a connected provider in this account scope.',
      inputSchema: z.toJSONSchema(repositoryListArgs(authority), { io: 'input' }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    {
      name: 'search_models',
      description:
        'Find model IDs and supported variants. Copy the exact ID into model and pass any variant separately; do not invent IDs or variants.',
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
      description: 'Generate a message ID for one new follow-up. This does not send work.',
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
      delete properties.baseBranch;
      delete properties.upstreamSha;
      if (tool.procedure !== 'prepareSession') delete properties.stackOnWorktreeId;
      if (authority.organizationId === null) delete properties.bitbucketRepo;
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
      const readOnly = cloudAgentAuthorityProcedureKind(path) === 'query';
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: { ...schema, properties, required },
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: [
            'interruptSession',
            'cancelQueuedMessage',
            'restackWorktreeBranch',
            'syncWorktreeBranch',
          ].includes(tool.procedure),
          idempotentHint: readOnly,
          openWorldHint: true,
        },
      };
    }),
  ];
}

const repositoryListProcedures = {
  github: 'listGitHubRepositories',
  gitlab: 'listGitLabRepositories',
  bitbucket: 'listBitbucketRepositories',
} as const;

function repositoryListArgs(authority: CloudAgentAuthority) {
  return z
    .object({
      platform:
        authority.organizationId === null
          ? z.enum(['github', 'gitlab'])
          : z.enum(['github', 'gitlab', 'bitbucket']),
      forceRefresh: z.boolean().optional(),
    })
    .strict();
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
  if (name === 'list_repositories') {
    const parsed = repositoryListArgs(authority).safeParse(args);
    if (!parsed.success)
      throw new JsonRpcFailure(
        -32602,
        'Choose a repository provider available in this account scope.'
      );
    const prefix =
      authority.organizationId === null ? 'cloudAgentNext' : 'organizations.cloudAgentNext';
    return callCatalogEndpoint({
      ...options,
      path: `${prefix}.${repositoryListProcedures[parsed.data.platform]}`,
      input: {
        forceRefresh: parsed.data.forceRefresh ?? false,
        ...(authority.organizationId === null ? {} : { organizationId: authority.organizationId }),
      },
    });
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
  const result = await callCatalogEndpoint({
    ...options,
    path,
    input: {
      ...args,
      ...(operation.procedure === 'getSessionMessagesPage'
        ? { limit: args.limit ?? 5, toolDisplay: args.toolDisplay ?? 'preview' }
        : {}),
      ...(operation.procedure === 'prepareSession' ? { autoInitiate: true } : {}),
      ...(authority.organizationId === null && !folderOperation
        ? {}
        : { organizationId: authority.organizationId }),
    },
  });
  if (operation.procedure !== 'getAttachmentUploadUrl') return result;
  const upload = z
    .object({ signedUrl: z.url(), key: z.string(), expiresAt: z.string() })
    .parse(JSON.parse(result.text));
  const file = upload.key.split('/').at(-1);
  return {
    text: JSON.stringify({ ...upload, attachments: { path: args.messageUuid, files: [file] } }),
    truncated: false,
  };
}
