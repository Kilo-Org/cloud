import { type ModelRequest } from '@kilocode/harness-sdk';

import { type NativeTool, nativeTools } from './native-tool-schema';

export type NativeToolCall = {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
};

/** A base64 image and its media type, as the harness prompt carries it. */
type NativeImage = { readonly media: string; readonly data: string };

/**
 * One transcript entry. The text roles reach every provider; a user entry
 * carries images only for a model that reads them. The tool roles reach only
 * a provider that runs tools, and each output names its call.
 */
type NativeMessage =
  | {
      readonly role: 'user' | 'assistant';
      readonly text: string;
      readonly images?: readonly NativeImage[];
    }
  | { readonly role: 'toolCalls'; readonly calls: readonly NativeToolCall[] }
  | {
      readonly role: 'toolOutput';
      readonly callId: string;
      readonly name: string;
      readonly text: string;
    };

/** What the Apple and Android inference modules receive for one generation. */
export type NativeRequest = {
  readonly id: string;
  readonly system: string;
  readonly messages: readonly NativeMessage[];
  readonly maxTokens: number;
  readonly tools?: readonly NativeTool[];
};

export type NativeToolResult = { readonly callId: string; readonly body: string };

type RequestOptions = {
  readonly id: string;
  /** The provider's output ceiling; zero when it reports none. */
  readonly ceiling: number;
  /** Whether the provider runs the tool loop. */
  readonly tools: boolean;
  /** Whether the provider's model reads image parts. */
  readonly images: boolean;
  /** The most images one request can carry; absent means no fixed limit. */
  readonly maxImages?: number;
};

/**
 * What a model gets in place of an image over its per-request limit. The
 * newest images are the ones sent, and the model is told an older one was there.
 */
export const IMAGE_NOT_SENT =
  '[An image was shared here. This model reads only the most recent images, so it is not sent.]';

/**
 * The transcript a system model reads. Reasoning never reaches it. User images
 * reach only a model that reads them, newest first within its image limit.
 * Tool calls and results reach only a model that runs tools, and then only in
 * pairs: a call with no result, or a result with no call, is left out.
 */
export function nativeRequest(request: ModelRequest, options: RequestOptions): NativeRequest {
  const { id, ceiling, tools, images: readsImages } = options;
  const answered = new Set(
    request.prompt.messages.flatMap(message =>
      message.parts.flatMap(part => (part.kind === 'toolResult' ? [part.callId] : []))
    )
  );
  const userImages = readsImages
    ? request.prompt.messages
        .filter(message => message.role === 'user')
        .flatMap(message => message.parts.filter(part => part.kind === 'image')).length
    : 0;
  // The oldest images over the limit are not sent, so the newest take the room.
  let unsent = Math.max(0, userImages - (options.maxImages ?? Number.POSITIVE_INFINITY));
  // The name of each call by its id, for the output that answers it.
  const names = new Map<string, string>();
  const messages: NativeMessage[] = [];
  for (const message of request.prompt.messages) {
    const texts: string[] = [];
    const images: NativeImage[] = [];
    for (const part of message.parts) {
      if (part.kind === 'text') {
        texts.push(part.text);
      } else if (part.kind === 'image' && readsImages && message.role === 'user') {
        if (unsent > 0) {
          unsent -= 1;
          texts.push(IMAGE_NOT_SENT);
        } else {
          images.push({ media: part.media, data: part.data });
        }
      }
    }
    const text = texts.join('\n\n');
    for (const part of tools ? message.parts : []) {
      const name = part.kind === 'toolResult' ? names.get(part.callId) : undefined;
      if (part.kind === 'toolResult' && name !== undefined) {
        messages.push({ role: 'toolOutput', callId: part.callId, name, text: part.body });
      }
    }
    if (images.length > 0) {
      messages.push({ role: message.role, text, images });
    } else if (text !== '') {
      messages.push({ role: message.role, text });
    }
    const calls = (tools ? message.parts : []).flatMap(part =>
      part.kind === 'toolCall' && answered.has(part.callId)
        ? [{ id: part.callId, name: part.name, arguments: part.arguments }]
        : []
    );
    for (const call of calls) {
      names.set(call.id, call.name);
    }
    if (calls.length > 0) {
      messages.push({ role: 'toolCalls', calls });
    }
  }
  const offered = tools && request.tools !== undefined ? nativeTools(request.tools) : [];
  return {
    id,
    system: request.prompt.system.map(block => block.text).join('\n\n'),
    messages,
    maxTokens: ceiling > 0 ? Math.min(request.maxTokens, ceiling) : request.maxTokens,
    ...(offered.length > 0 ? { tools: offered } : {}),
  };
}

/** The results when the request ends on them alone: the harness answering a tool round. */
export function resultsOf(request: ModelRequest): NativeToolResult[] | undefined {
  const last = request.prompt.messages.at(-1);
  const results = (last?.parts ?? []).flatMap(part =>
    part.kind === 'toolResult' ? [{ callId: part.callId, body: part.body }] : []
  );
  return last?.role === 'user' && results.length > 0 && results.length === last.parts.length
    ? results
    : undefined;
}
