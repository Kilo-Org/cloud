import { z } from 'zod';
import type { Kilo2Message } from '@kilocode/session-ingest-contracts';
import type { ToolPart } from './types';

const common = {
  state: z.string(),
  outcome: z.enum(['finished', 'failed', 'cancelled', 'terminated', 'unknown']),
  description: z.string(),
  output: z.string(),
};
export const backgroundResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('shell'),
    ...common,
    shellID: z.string(),
    command: z.string(),
    exit: z.number().int().optional(),
    truncated: z.boolean(),
  }),
  z.object({
    kind: z.literal('subagent'),
    ...common,
    childID: z.string().regex(/^ses_[\w-]+$/),
    agent: z.string(),
  }),
  z.object({ kind: z.literal('notice'), ...common }),
]);
export type BackgroundResult = z.infer<typeof backgroundResultSchema>;

export function backgroundOutcome(
  input:
    | { kind: 'shell'; state: string; exit?: number | undefined }
    | { kind: 'subagent'; state: string }
): BackgroundResult['outcome'] {
  const { state } = input;
  const exit = input.kind === 'shell' ? input.exit : undefined;
  if (state === 'cancelled' || state === 'canceled') return 'cancelled';
  if (['killed', 'terminated', 'interrupted'].includes(state)) return 'terminated';
  if (['error', 'failed', 'timeout'].includes(state) || (exit !== undefined && exit !== 0))
    return 'failed';
  if (state === 'completed')
    return input.kind === 'subagent' || exit === 0 ? 'finished' : 'unknown';
  return 'unknown';
}

export function backgroundResultLabel(result: BackgroundResult): string {
  if (result.kind === 'notice') return 'Agent notice';
  const name = result.kind === 'shell' ? 'Shell' : result.agent || 'Agent';
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${result.outcome === 'unknown' ? 'ended' : result.outcome}`;
}

export function readBackgroundResult(part: ToolPart): BackgroundResult | undefined {
  if (
    !['background_shell_result', 'background_subagent_result', 'agent_notice'].includes(part.tool)
  )
    return;
  if (part.state.status === 'pending') return;
  const parsed = backgroundResultSchema.safeParse(part.state.metadata?.['backgroundResult']);
  return parsed.success ? parsed.data : undefined;
}

export function projectBackgroundResult(
  message: Kilo2Message,
  result: BackgroundResult
): Kilo2Message {
  return {
    ...message,
    type: 'assistant',
    time: { ...message.time, completed: message.time.created },
    content: [
      {
        type: 'tool',
        id: message.id,
        name: result.kind === 'notice' ? 'agent_notice' : `background_${result.kind}_result`,
        time: { created: message.time.created, completed: message.time.created },
        state: {
          input: {},
          metadata: {
            ...z.record(z.string(), z.unknown()).parse(message['metadata']),
            backgroundResult: result,
          },
          content: [{ type: 'text', text: result.output }],
          ...(result.outcome === 'failed'
            ? {
                status: 'error' as const,
                error: {
                  type: 'background',
                  message: [backgroundResultLabel(result), result.output]
                    .filter(Boolean)
                    .join('\n\n'),
                },
              }
            : { status: 'completed' as const }),
        },
      },
    ],
  };
}
