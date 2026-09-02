import { Fragment } from 'react';
import { Terminal } from 'lucide-react';
import * as z from 'zod';
import { ToolCardShell } from './ToolCardShell';
import { ToolCodeBlock } from './ToolOutput';
import { normalizeTerminalOutput } from './normalize-terminal-output';
import type { ToolPart } from './types';

const actionTitles = new Map([
  ['start', 'Start background process'],
  ['list', 'List background processes'],
  ['status', 'Check background process'],
  ['logs', 'View background logs'],
  ['stop', 'Stop background process'],
  ['restart', 'Restart background process'],
]);
const structuredActions = new Set(['start', 'status', 'stop', 'restart']);
const structuredKeys = new Set(['id', 'status', 'pid', 'cwd', 'command', 'last_output', 'output']);
const resultSchema = z.record(z.string(), z.unknown());
const readinessSchema = z.object({
  port: z.number().int().positive().optional(),
  pattern: z.string().optional(),
  timeout: z.number().positive().optional(),
});

function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return undefined;
}

function structuredOutput(raw: string, enabled: boolean) {
  const fields = new Map<string, string>();
  if (!enabled) return { fields, output: raw };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  const result = resultSchema.safeParse(parsed);
  if (result.success) {
    const rest = Object.fromEntries(
      Object.entries(result.data).filter(([key, value]) => {
        const valueText = text(value);
        if (!structuredKeys.has(key) || valueText === undefined) return true;
        fields.set(key, valueText);
        return false;
      })
    );
    return {
      fields,
      output:
        fields.size === 0 ? raw : Object.keys(rest).length ? JSON.stringify(rest, null, 2) : '',
    };
  }

  const rest: string[] = [];
  for (const line of raw.split('\n')) {
    const match = /^([a-z_]+):\s*(.*)$/.exec(line);
    const key = match?.[1];
    const value = match?.[2].trim();
    if (key && structuredKeys.has(key) && value && !fields.has(key)) {
      fields.set(key, value);
    } else {
      rest.push(line);
    }
  }
  return { fields, output: rest.join('\n').trimEnd() };
}

export function BackgroundProcessToolCard({ toolPart }: { toolPart: ToolPart }) {
  const state = toolPart.state;
  const input = state.input;
  const metadata = state.status === 'pending' ? undefined : state.metadata;
  const action = text(input.action) ?? 'status';
  const rawOutput = state.status === 'completed' ? normalizeTerminalOutput(state.output) : '';
  const data = structuredOutput(
    rawOutput,
    state.status === 'completed' && structuredActions.has(action)
  );
  const id = data.fields.get('id') ?? text(metadata?.processID) ?? text(input.id);
  const status = data.fields.get('status') ?? text(metadata?.status);
  const command = text(input.command) ?? data.fields.get('command');
  const description = text(input.description);
  const cwd = data.fields.get('cwd') ?? text(input.cwd) ?? text(input.workdir);
  const parsedReadiness = readinessSchema.safeParse(input.ready);
  const readiness = parsedReadiness.success ? parsedReadiness.data : undefined;
  const rows: [string, string | undefined][] = [
    ['Description', description],
    ['Process id', id],
    ['Status', status],
    ['PID', data.fields.get('pid')],
    ['Cwd', cwd],
    ['Readiness port', text(readiness?.port)],
    ['Readiness pattern', text(readiness?.pattern)],
    ['Readiness timeout', readiness?.timeout !== undefined ? `${readiness.timeout} ms` : undefined],
  ];
  const output = normalizeTerminalOutput(
    [data.fields.get('output'), data.output].filter(Boolean).join('\n\n')
  );
  const lastOutput = normalizeTerminalOutput(data.fields.get('last_output') ?? '');
  const count = metadata?.count;
  const subtitle =
    action === 'list' && typeof count === 'number' && Number.isInteger(count) && count >= 0
      ? `${count} ${count === 1 ? 'process' : 'processes'}`
      : (command ?? description ?? id);

  return (
    <ToolCardShell
      icon={Terminal}
      title={actionTitles.get(action) ?? 'Background process'}
      subtitle={subtitle}
      status={state.status}
    >
      <div
        role="region"
        tabIndex={0}
        aria-label="Background process details"
        className="focus-visible:ring-ring max-h-96 min-w-0 space-y-2 overflow-auto focus-visible:ring-2 focus-visible:outline-none"
      >
        {command && <ToolCodeBlock content={command} label="Command" />}
        {rows.some(([, value]) => value !== undefined) && (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            {rows.map(([label, value]) =>
              value !== undefined ? (
                <Fragment key={label}>
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{value}</dd>
                </Fragment>
              ) : null
            )}
          </dl>
        )}
        {lastOutput && <ToolCodeBlock content={lastOutput} label="Last output" />}
        {output.trim() ? <ToolCodeBlock content={output} label="Output" /> : null}
        {state.status === 'completed' && !rawOutput.trim() && (
          <div className="text-muted-foreground text-xs">No output.</div>
        )}
        {state.status === 'error' && (
          <ToolCodeBlock
            content={normalizeTerminalOutput(state.error)}
            label="Error"
            className="[&_pre]:text-destructive"
          />
        )}
        {state.status === 'running' && (
          <div className="text-muted-foreground text-xs">Waiting for process result...</div>
        )}
        {state.status === 'pending' && (
          <div className="text-muted-foreground text-xs">Waiting...</div>
        )}
      </div>
    </ToolCardShell>
  );
}
