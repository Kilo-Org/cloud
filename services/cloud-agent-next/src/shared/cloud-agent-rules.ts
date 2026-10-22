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
  ].join('\n');
}
