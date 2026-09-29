import { Fragment } from 'react';
import { AlarmClock } from 'lucide-react';
import { ToolCardShell } from './ToolCardShell';
import { ToolCodeBlock } from './ToolOutput';
import { normalizeTerminalOutput } from './normalize-terminal-output';
import type { ToolPart } from './types';

const MAX_LIST_ROWS = 20;

type ScheduledRow = {
  id: string;
  schedule: string;
  prompt?: string;
};

type ParsedOutput = {
  id?: string;
  schedule?: string;
  prompt?: string;
  rows?: ScheduledRow[];
  leftover?: string;
};

function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function title(tool: string, input: Record<string, unknown>): string {
  if (tool === 'cancel_wakeup') {
    return text(input.action) === 'cancel' ? 'Cancel wakeup' : 'List wakeups';
  }
  switch (tool) {
    case 'schedule_wakeup':
      return 'Schedule wakeup';
    case 'cron_create':
      return 'Create cron task';
    case 'cron_list':
      return 'List cron tasks';
    case 'cron_delete':
      return 'Delete cron task';
    default:
      return 'Scheduled task';
  }
}

function wakeupConfirmation(output: string): ParsedOutput | undefined {
  const match =
    /^Scheduled wakeup (\S+), due (.+?) \(in ([^)]+)\)\.(?:\s*When it fires this session resumes with:\s*([\s\S]*))?$/.exec(
      output.trim()
    );
  if (!match) return undefined;
  return {
    id: match[1],
    schedule: `due ${match[2]} (in ${match[3]})`,
    prompt: match[4]?.trim() || undefined,
  };
}

function cronConfirmation(output: string): ParsedOutput | undefined {
  const match =
    /^Scheduled cron task (\S+), schedule (.+?), next fire (.+?) \(in ([^)]+)\)\.(?:\s*When it fires this session resumes with:\s*([\s\S]*))?$/.exec(
      output.trim()
    );
  if (!match) return undefined;
  return {
    id: match[1],
    schedule: `${match[2]} · next ${match[3]} (in ${match[4]})`,
    prompt: match[5]?.trim() || undefined,
  };
}

function cancelConfirmation(output: string): ParsedOutput | undefined {
  const match = /^Cancelled wakeup (\S+) \((.+?)\)\.$/.exec(output.trim());
  if (!match) return undefined;
  return { id: match[1], schedule: `due ${match[2]}` };
}

function deleteConfirmation(output: string): ParsedOutput | undefined {
  const match = /^Deleted cron task (\S+) \(next (.+?)\)\.$/.exec(output.trim());
  if (!match) return undefined;
  return { id: match[1], schedule: `next ${match[2]}` };
}

function listRows(output: string, kind: 'wakeup' | 'cron'): ParsedOutput {
  const rows: ScheduledRow[] = [];
  const leftover: string[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match =
      kind === 'cron'
        ? /^(\S+)\s+(.+?)\s+next\s+(.+?)\s+\(in\s+([^)]+)\)(?:\s+(.*))?$/.exec(trimmed)
        : /^(\S+)\s+due\s+(.+?)\s+\(in\s+([^)]+)\)(?:\s+(.*))?$/.exec(trimmed);
    if (!match) {
      leftover.push(trimmed);
      continue;
    }
    rows.push(
      kind === 'cron'
        ? {
            id: match[1],
            schedule: `${match[2]} · next ${match[3]} (in ${match[4]})`,
            prompt: match[5]?.trim() || undefined,
          }
        : {
            id: match[1],
            schedule: `due ${match[2]} (in ${match[3]})`,
            prompt: match[4]?.trim() || undefined,
          }
    );
  }
  if (rows.length === 0) return { rows, leftover: leftover.join('\n') || output.trim() };
  return { rows, leftover: leftover.join('\n') || undefined };
}

function parseOutput(tool: string, input: Record<string, unknown>, output: string): ParsedOutput {
  switch (tool) {
    case 'schedule_wakeup':
      return wakeupConfirmation(output) ?? { leftover: output.trim() };
    case 'cron_create':
      return cronConfirmation(output) ?? { leftover: output.trim() };
    case 'cron_delete':
      return deleteConfirmation(output) ?? { leftover: output.trim() };
    case 'cancel_wakeup':
      return text(input.action) === 'cancel'
        ? (cancelConfirmation(output) ?? { leftover: output.trim() })
        : listRows(output, 'wakeup');
    case 'cron_list':
      return listRows(output, 'cron');
    default:
      return { leftover: output.trim() };
  }
}

export function ScheduledTaskToolCard({ toolPart }: { toolPart: ToolPart }) {
  const state = toolPart.state;
  const input = state.input;
  const output = state.status === 'completed' ? normalizeTerminalOutput(state.output) : '';
  const parsed = state.status === 'completed' ? parseOutput(toolPart.tool, input, output) : {};
  const prompt = text(input.prompt) ?? parsed.prompt;
  const schedule =
    parsed.schedule ??
    text(input.cron) ??
    (text(input.when) ? `at ${text(input.when)}` : undefined) ??
    (text(input.delay) ? `in ${text(input.delay)}` : undefined);
  const id = parsed.id ?? text(input.id);
  const reason = text(input.reason);
  const rows: [string, string | undefined][] = [
    ['Schedule', schedule],
    ['Task id', id],
    ['Reason', reason],
  ];
  const count = parsed.rows?.length;
  const subtitle =
    count !== undefined
      ? count === 0
        ? 'None scheduled'
        : `${count} ${count === 1 ? 'task' : 'tasks'}`
      : (schedule ?? id ?? prompt);
  const visibleRows = parsed.rows?.slice(0, MAX_LIST_ROWS) ?? [];
  const hiddenRows = (parsed.rows?.length ?? 0) - visibleRows.length;

  return (
    <ToolCardShell
      icon={AlarmClock}
      title={title(toolPart.tool, input)}
      subtitle={subtitle}
      status={state.status}
    >
      <div
        role="region"
        tabIndex={0}
        aria-label="Scheduled task details"
        className="focus-visible:ring-ring max-h-96 min-w-0 space-y-2 overflow-auto focus-visible:ring-2 focus-visible:outline-none"
      >
        {prompt && <ToolCodeBlock content={prompt} label="Prompt" />}
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
        {visibleRows.length > 0 && (
          <ul aria-label="Scheduled tasks" className="space-y-1 text-xs">
            {visibleRows.map(row => (
              <li key={row.id} className="min-w-0">
                <code className="[overflow-wrap:anywhere]">{row.id}</code>
                <div className="text-muted-foreground [overflow-wrap:anywhere]">{row.schedule}</div>
                {row.prompt && <div className="[overflow-wrap:anywhere]">{row.prompt}</div>}
              </li>
            ))}
            {hiddenRows > 0 && <li className="text-muted-foreground">+{hiddenRows} more</li>}
          </ul>
        )}
        {count === 0 && (
          <div className="text-muted-foreground text-xs">
            {parsed.leftover || 'No scheduled tasks.'}
          </div>
        )}
        {count !== 0 && parsed.leftover && (
          <ToolCodeBlock content={parsed.leftover} label="Output" />
        )}
        {state.status === 'completed' && !output.trim() && (
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
          <div className="text-muted-foreground text-xs">Waiting for scheduler result...</div>
        )}
        {state.status === 'pending' && (
          <div className="text-muted-foreground text-xs">Waiting...</div>
        )}
      </div>
    </ToolCardShell>
  );
}
