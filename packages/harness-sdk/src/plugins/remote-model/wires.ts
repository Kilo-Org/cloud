import { createIs } from 'typia';
import type { ApiKind } from '../../core/catalog.js';
import { completionsWire } from '../gateway/wire/completions.js';
import { remoteCompletionsBody } from '../gateway/wire/completions-body.js';
import { messagesWire } from '../gateway/wire/messages.js';
import { responsesWire } from '../gateway/wire/responses.js';
import { isFailure, type Wire, type WirePart } from '../gateway/wire/wire.js';
import type { RemoteModelConfig } from './index.js';

interface ChatCalls {
  choices: {
    delta: {
      tool_calls: {
        index: number;
        id?: string | null;
        function?: { name?: string | null; arguments?: string | null } | null;
      }[];
    };
  }[];
}
interface ChatRefusal {
  choices: { delta: { refusal: string } }[];
}
interface ChatMixedReasoning {
  choices: {
    delta: { content: string; reasoning?: string | null; reasoning_content?: string | null };
  }[];
}
type ResponseCall =
  | {
      type: 'response.output_item.added';
      output_index: number;
      item: { type: 'function_call'; call_id: string; name: string; arguments?: string };
    }
  | { type: 'response.function_call_arguments.delta'; output_index: number; delta: string }
  | { type: 'response.output_item.done'; output_index: number; item: { type: 'function_call' } };
type MessageCall =
  | {
      type: 'content_block_start';
      index: number;
      content_block: {
        type: 'tool_use';
        id: string;
        name: string;
        input?: Record<string, unknown>;
      };
    }
  | { type: 'content_block_delta'; index: number; delta: { partial_json: string } }
  | { type: 'content_block_stop'; index: number };
type ResponseFailure =
  | { type: 'error'; message: string }
  | { type: 'response.failed'; response: { status: 'failed' } };
interface ResponseRefusal {
  type: 'response.refusal.delta';
  delta: string;
}
const isChatCalls = createIs<ChatCalls>();
const isChatRefusal = createIs<ChatRefusal>();
const isChatMixedReasoning = createIs<ChatMixedReasoning>();
const isResponseCall = createIs<ResponseCall>();
const isMessageCall = createIs<MessageCall>();
const isResponseRefusal = createIs<ResponseRefusal>();
const isResponseFailure = createIs<ResponseFailure>();

const textParts = (wire: Wire, event: unknown): WirePart[] => {
  const part = wire.toDelta(event);
  return part !== undefined &&
    (part.kind === 'delta' || part.kind === 'reasoning' || part.kind === 'redacted')
    ? [part]
    : [];
};

const appendChatTools = (event: unknown, parts: WirePart[]): void => {
  if (!isChatCalls(event)) {
    return;
  }
  for (const call of event.choices[0]?.delta.tool_calls ?? []) {
    const key = String(call.index);
    const text = call.function?.arguments ?? '';
    const name = call.function?.name ?? '';
    const id = call.id ?? undefined;
    parts.push(
      id === undefined
        ? { kind: 'callArguments', key, text, name }
        : { kind: 'callStart', key, id, name, text }
    );
  }
};

const appendChatRefusal = (event: unknown, parts: WirePart[]): void => {
  const refusal = isChatRefusal(event) ? event.choices[0]?.delta.refusal : undefined;
  if (refusal !== undefined) {
    parts.push({ kind: 'delta', text: refusal });
  }
};

const chatParts = (event: unknown): readonly WirePart[] | undefined => {
  const thought = isChatMixedReasoning(event)
    ? (event.choices[0]?.delta.reasoning ?? event.choices[0]?.delta.reasoning_content ?? undefined)
    : undefined;
  if (!isChatCalls(event) && !isChatRefusal(event) && thought === undefined) {
    return undefined;
  }
  const parts = textParts(completionsWire, event);
  if (thought !== undefined && parts[0]?.kind !== 'reasoning') {
    parts.push({ kind: 'reasoning', text: thought });
  }
  appendChatRefusal(event, parts);
  appendChatTools(event, parts);
  return parts;
};

const responseToolPart = (event: ResponseCall): WirePart => {
  const key = String(event.output_index);
  switch (event.type) {
    case 'response.output_item.added': {
      return {
        kind: 'callStart',
        key,
        id: event.item.call_id,
        name: event.item.name,
        text: event.item.arguments ?? '',
      };
    }
    case 'response.function_call_arguments.delta': {
      return { kind: 'callArguments', key, text: event.delta };
    }
    case 'response.output_item.done': {
      return { kind: 'callEnd', key };
    }
  }
};

const responseParts = (event: unknown): readonly WirePart[] | undefined => {
  if (!isResponseCall(event) && !isResponseRefusal(event)) {
    return undefined;
  }
  const parts = textParts(responsesWire, event);
  if (isResponseRefusal(event)) {
    parts.push({ kind: 'delta', text: event.delta });
  }
  if (isResponseCall(event)) {
    parts.push(responseToolPart(event));
  }
  return parts;
};

const messageParts = (event: unknown): readonly WirePart[] | undefined => {
  if (!isMessageCall(event)) {
    return undefined;
  }
  const key = String(event.index);
  switch (event.type) {
    case 'content_block_start': {
      const { input } = event.content_block;
      const text =
        input === undefined || Object.keys(input).length === 0 ? '' : JSON.stringify(input);
      return [
        {
          kind: 'callStart',
          key,
          id: event.content_block.id,
          name: event.content_block.name,
          text,
        },
      ];
    }
    case 'content_block_delta': {
      return [{ kind: 'callArguments', key, text: event.delta.partial_json }];
    }
    case 'content_block_stop': {
      return [{ kind: 'callEnd', key, emptyArguments: '{}' }];
    }
  }
};

const protocols: Readonly<
  Record<
    ApiKind,
    {
      readonly wire: Wire;
      readonly path: string;
      readonly parts: (event: unknown) => readonly WirePart[] | undefined;
    }
  >
> = {
  chat_completions: { wire: completionsWire, path: '/chat/completions', parts: chatParts },
  responses: { wire: responsesWire, path: '/responses', parts: responseParts },
  messages: { wire: messagesWire, path: '/messages', parts: messageParts },
};

/** Reuse Kilo's readers; direct providers additionally address concurrent tools by index. */
const remoteWireFor = (
  kind: ApiKind,
  completionTokenField?: RemoteModelConfig['completionTokenField']
): Wire => {
  const protocol = protocols[kind];
  let refused = false;
  return {
    ...protocol.wire,
    path: protocol.path,
    toBody:
      kind === 'chat_completions'
        ? request => remoteCompletionsBody(request, completionTokenField)
        : protocol.wire.toBody,
    isFailure: event => isFailure(event) || (kind === 'responses' && isResponseFailure(event)),
    toParts: protocol.parts,
    toStop: event => {
      if (
        (kind === 'responses' && isResponseRefusal(event) && event.delta.length > 0) ||
        (kind === 'chat_completions' &&
          isChatRefusal(event) &&
          (event.choices[0]?.delta.refusal.length ?? 0) > 0)
      ) {
        refused = true;
      }
      return refused ? 'refusal' : protocol.wire.toStop(event);
    },
  };
};

export { remoteWireFor };
