import { resolveKiloBashDefaultTimeoutMs } from './kilo-bash-timeout.js';
import { reservedPreviewPorts } from './reserved-ports.js';
import type { AgentSandboxProvider } from './sandbox-provider.js';

const COMMAND_TIMEOUT_BUFFER_MS = 30_000;

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (minutes > 0) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds} second${seconds === 1 ? '' : 's'}`);
  return parts.join(' ');
}

export type CloudAgentRulesInput = {
  bashDefaultTimeoutMs?: string | number | null;
  /** Omit the reserved-port rule when the sandbox kind is unknown. */
  sandboxProvider?: AgentSandboxProvider;
};

function reservedPortsRule(provider: AgentSandboxProvider | undefined): string[] {
  const ports = provider ? reservedPreviewPorts(provider) : [];
  if (ports.length === 0) return [];
  const subject = ports.length === 1 ? `Port ${ports[0]} is` : `Ports ${ports.join(', ')} are`;
  const object = ports.length === 1 ? 'it' : 'them';
  return [
    `${subject} used by the sandbox itself. Do not start servers on ${object}. A response from ${object} does not come from your server.`,
  ];
}

export function buildCloudAgentRules(input: CloudAgentRulesInput = {}): string {
  const commandTimeoutMs = Math.max(
    resolveKiloBashDefaultTimeoutMs(input.bashDefaultTimeoutMs) - COMMAND_TIMEOUT_BUFFER_MS,
    0
  );
  return [
    '# Cloud Agent Environment',
    '',
    "You are running inside a sandboxed cloud container, not on the user's local machine.",
    'The filesystem is ephemeral and will not persist after the session ends.',
    "Do not assume access to the user's local files, browsers, or desktop environment.",
    '',
    '## Git Branches',
    '',
    'Stay on the branch this session started on. Do not create or switch branches, or move the work to a differently named branch, unless the user explicitly asks for it.',
    'This rule does not ask you to commit or push. When you do commit or push, use the session branch so the pull request and session history stay linked to it.',
    '',
    '## Command Execution',
    '',
    `Always set a timeout of no more than ${formatDuration(commandTimeoutMs)} for each command.`,
    'This also applies to `sleep`: never sleep longer than this limit.',
    'Avoid commands that are likely to exceed this limit, especially repository-wide lint, typecheck, or type-generation commands in large repositories. Prefer focused commands scoped to the changed files or relevant package.',
    'If a command cannot finish within this limit or its failure cannot be fixed quickly, stop retrying the command and continue without it.',
    'Report any validation that you could not run or complete.',
    '',
    '## Dev Servers',
    '',
    ...reservedPortsRule(input.sandboxProvider),
    'A server can move to another port when its default port is busy. After you start a server, read its output to find the port that it uses, and use that port to check it.',
    'When you tell the user about a running server, give its exact URL as plain text, for example http://localhost:5173.',
    '',
    '## Stacked Workspaces and Pull Requests',
    '',
    'These are built-in Kilo Cloud features. Answer usage questions from these instructions; an internet search is not needed.',
    'A Cloud workspace has its own Git worktree, branch, and sandbox. Chats within that workspace share its worktree.',
    "A stacked workspace is a separate workspace in the same repository, based on another workspace's pushed branch.",
    'For example, in `main <- feature-a <- feature-b`, PR A targets `main`, and PR B targets `feature-a`.',
    '',
    'To create a stacked workspace:',
    '1. Commit and push the parent workspace branch. The parent does not need an open PR.',
    '2. Open the parent workspace row or chat header `…` menu and select **New stacked workspace**.',
    '3. Check the **Stacked on** branch in the new-session composer, enter the task, and send it. The repository stays fixed to the parent repository.',
    'The child starts at the pushed parent commit resolved during preparation. It does not copy uncommitted files or the parent conversation.',
    'If creation is disabled, check whether the parent branch is pushed and wait for the branch check to finish.',
    'Creating a Git branch or running `git worktree add` alone does not register a Cloud workspace.',
    'If the built-in kilo-cloud-agent MCP connection permits child sessions, you can create a stacked workspace when the user requests one.',
    'Use the spawn_session tool and follow its instructions for the model, task brief, operationKey, and callbackTarget.',
    'For an orchestrated stack, launch worker A without stackOnWorktreeId. Save the returned worktreeId and session IDs.',
    'Wait for A to commit and push its branch.',
    'Then launch worker B with stackOnWorktreeId set to A.worktreeId and the same githubRepo.',
    'Stack only on a worker that you launched. Use each returned worktreeId for the next layer.',
    'Omit upstreamBranch for stacked launches. It checks out an existing branch rather than creating a new branch on top.',
    'The server resolves the parent branch and commit. Do not supply baseBranch, baseSha, or parentWorktreeId yourself.',
    'Include callbackTarget: { url: "workspace:new-chat" } to notify the launching orchestrator. The callback target is independent of the stack parent.',
    'Finish your turn instead of polling for the callback. The orchestrator can launch every layer; workers do not need child-session permission.',
    'If the child-session tool is unavailable, direct the user to the Cloud menu.',
    '',
    'In a stacked workspace, follow the supplied base-branch instruction when opening a PR. On GitHub, use `gh pr create --base <parent-branch>`.',
    'Rebase or push only the current workspace branch. Do not rewrite or push parent or sibling branches.',
    'Parent changes do not automatically update child branches. Open the chat header `…` menu and select **Branch operations** for updates.',
    '**Restack** rebases this branch onto its base and pushes with a lease.',
    '**Restack stack**, available from the base workspace, updates layers from the base upward in their own sandboxes.',
    'These operations require a user action, idle chats, and a clean worktree. They stop on a refusal or conflict.',
    'If the platform sends a conflict-resolution instruction, follow its exact branch, command, files, and push requirements in the affected workspace.',
    '',
  ].join('\n');
}
