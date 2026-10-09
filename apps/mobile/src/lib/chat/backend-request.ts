import { type FetchLike, type HttpRequest } from '@kilocode/harness-sdk';
import { remoteModelClient } from '@kilocode/harness-sdk/plugins/remote-model';
import { Effect, Schedule, Stream } from 'effect';
import { fetch as nativeFetch } from 'expo/fetch';
import { z } from 'zod';

import { remoteChatFetch } from './fetch';
import { assertBackendTransport } from './backend-transport';
import {
  type BackendConnection,
  type BackendModel,
  type ChatBackendDraft,
  validateBackendConnection,
  validateChatBackendDraft,
} from './backend-store';

export type BackendConnectionCheckOptions = { signal: AbortSignal; transport?: FetchLike };
/** Custom headers override defaults case-insensitively; never merge Kilo auth. */
export function backendHeaders(
  profile: Pick<ChatBackendDraft, 'apiKind' | 'apiKey' | 'headers'>
): HttpRequest['headers'] {
  const headers: Record<string, string> = {};
  if (profile.apiKind === 'messages') {
    headers['anthropic-version'] = '2023-06-01';
    if (profile.apiKey) {
      headers['x-api-key'] = profile.apiKey;
    }
  } else if (profile.apiKey) {
    headers.authorization = `Bearer ${profile.apiKey}`;
  }
  for (const [name, value] of Object.entries(profile.headers)) {
    headers[name.toLowerCase()] = value;
  }
  return headers;
}

const modelListSchema = z
  .object({
    data: z.array(
      z.object({ id: z.string().trim().min(1), name: z.string().trim().min(1).optional() }).strip()
    ),
  })
  .strip();

export type BackendDiscoveryFetch = (
  url: string,
  request: {
    method: 'GET';
    headers: Record<string, string>;
    signal: AbortSignal;
    redirect: 'error';
    credentials: 'omit';
  }
) => Promise<{ ok: boolean; text: () => Promise<string> }>;

/** Discovery is optional; callers retain their manual models on any failure. */
export async function discoverBackendModels(
  input: BackendConnection,
  signal: AbortSignal,
  transport: BackendDiscoveryFetch = nativeFetch
): Promise<BackendModel[]> {
  const profile = validateBackendConnection(input);
  const baseUrl = profile.baseUrl;
  assertBackendTransport(baseUrl);
  const controller = new AbortController();
  const abort = () => {
    controller.abort();
  };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) {
    controller.abort();
  }
  const deadline = setTimeout(abort, 15_000);
  try {
    const response = await transport(`${baseUrl}/models`, {
      method: 'GET',
      headers: backendHeaders(profile),
      signal: controller.signal,
      redirect: 'error',
      credentials: 'omit',
    });
    if (!response.ok) {
      throw new Error('Model discovery request failed');
    }
    const data: unknown = JSON.parse(await response.text());
    const parsed = modelListSchema.parse(data);
    const seen = new Set<string>();
    const models: BackendModel[] = [];
    for (const model of parsed.data) {
      if (!seen.has(model.id)) {
        models.push({ id: model.id, name: model.name ?? model.id, tools: false });
        seen.add(model.id);
      }
    }
    if (models.length === 0) {
      throw new Error('The endpoint returned no models');
    }
    return models;
  } catch {
    // Provider text can echo authorization headers or API keys.
    throw new Error('discoveryFailed');
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener('abort', abort);
  }
}

/** This is an explicitly requested, billable inference, not a /models ping. */
export async function checkBackendConnection(
  input: ChatBackendDraft,
  modelId: string,
  { signal, transport = remoteChatFetch }: BackendConnectionCheckOptions
): Promise<void> {
  const profile = validateChatBackendDraft(input);
  assertBackendTransport(profile.baseUrl);
  if (!profile.models.some(model => model.id === modelId)) {
    throw new Error('invalidInput');
  }
  const client = remoteModelClient(
    {
      baseUrl: profile.baseUrl,
      apiKind: profile.apiKind,
      completionTokenField: profile.completionTokenField,
      fetch: transport,
      headers: () => Effect.succeed(backendHeaders(profile)),
    },
    { schedule: Schedule.recurs(0) }
  );
  try {
    const result = await Effect.runPromise(
      Stream.runFold(
        client.stream({
          model: modelId,
          maxTokens: 16,
          prompt: {
            system: [],
            messages: [
              { role: 'user', cache: false, parts: [{ kind: 'text', text: 'Reply OK.' }] },
            ],
          },
        }),
        { receivedText: false, completed: false },
        (held, event) => {
          if (event.kind === 'delta' && event.text !== '') {
            held.receivedText = true;
          }
          if (event.kind === 'done') {
            held.completed = event.stop === 'end' || event.stop === 'maxTokens';
          }
          return held;
        }
      ).pipe(Effect.timeout('15 seconds')),
      { signal }
    );
    if (!result.receivedText || !result.completed) {
      throw new Error('The model response was incomplete');
    }
  } catch {
    throw new Error('connectionFailed');
  }
}
