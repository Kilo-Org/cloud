import { type Part, type ToolPart } from '@kilocode/cloud-agent-sdk';
import { type ModelEvent, type ToolResult } from '@kilocode/harness-sdk';
import { z } from 'zod';

const toolInputSchema = z.record(z.string(), z.unknown());

function toolInput(raw: string) {
  try {
    return toolInputSchema.parse(JSON.parse(raw));
  } catch {
    return { arguments: raw };
  }
}

export function pendingTool(input: {
  readonly id: string;
  readonly sessionID: string;
  readonly messageID: string;
  readonly callID: string;
  readonly tool: string;
  readonly raw: string;
}): ToolPart {
  const { raw, ...identity } = input;
  return { ...identity, type: 'tool', state: { status: 'pending', input: toolInput(raw), raw } };
}

export function resolvedTool(part: ToolPart, result: ToolResult, end = 0): ToolPart {
  const start = part.state.status === 'pending' ? end : part.state.time.start;
  const input = part.state.input;
  return {
    ...part,
    state: result.failed
      ? { status: 'error', input, error: result.body, time: { start, end } }
      : {
          status: 'completed',
          input,
          output: result.body,
          title: part.tool,
          metadata: {},
          time: { start, end },
        },
  };
}

export function answerParts({
  sessionId,
  parts,
  event,
  now,
}: {
  readonly sessionId: string;
  readonly parts: readonly Part[];
  readonly event: ModelEvent;
  readonly now: number;
}): readonly Part[] {
  const messageID = `${sessionId}:answering`;
  switch (event.kind) {
    case 'delta':
    case 'reasoning': {
      if (event.text === '') {
        return parts;
      }
      const type = event.kind === 'delta' ? 'text' : 'reasoning';
      const last = parts.at(-1);
      if (last?.type === type) {
        return [...parts.slice(0, -1), { ...last, text: last.text + event.text }];
      }
      const identity = { id: `${messageID}:${parts.length}`, sessionID: sessionId, messageID };
      return [
        ...parts,
        type === 'text'
          ? { ...identity, type, text: event.text }
          : { ...identity, type, text: event.text, time: { start: now } },
      ];
    }
    case 'toolCall': {
      return [
        ...parts,
        pendingTool({
          id: `${messageID}:${parts.length}`,
          sessionID: sessionId,
          messageID,
          callID: event.call.id,
          tool: event.call.name,
          raw: event.call.arguments,
        }),
      ];
    }
    case 'done': {
      return parts.map(part => {
        if (part.type === 'tool' && part.state.status === 'pending') {
          return {
            ...part,
            state: { status: 'running', input: part.state.input, time: { start: now } },
          };
        }
        if (part.type === 'reasoning' && part.time.end === undefined) {
          return { ...part, time: { ...part.time, end: now } };
        }
        return part;
      });
    }
    case 'toolResult': {
      const index = parts.findLastIndex(
        part =>
          part.type === 'tool' &&
          part.callID === event.result.callId &&
          (part.state.status === 'pending' || part.state.status === 'running')
      );
      return parts.map((part, position) =>
        position === index && part.type === 'tool' ? resolvedTool(part, event.result, now) : part
      );
    }
    case 'redacted': {
      return parts;
    }
    default: {
      return parts;
    }
  }
}
