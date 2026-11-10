'use client';

import { z } from 'zod';

// Supported browsers lack Promise.withResolvers, so this module uses Promise constructors.

const sdkUrl = 'https://cdn.platform.openai.com/deployments/watchwood/watchwood.js';
const scriptId = 'watchwood-sdk';
const timeoutMs = 2_000;
const contextSchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }),
  z.object({
    enabled: z.literal(true),
    org_id: z.string().min(1).max(1024),
    safety_identifier: z.string().min(1).max(64),
  }),
]);
const sdkSchema = z.object({
  initialize: z.custom<(options: { org_id: string; safety_identifier: string }) => unknown>(
    value => typeof value === 'function'
  ),
  getToken: z.custom<() => unknown>(value => typeof value === 'function'),
});
const tokenSchema = z.object({
  token: z.string().min(1).max(8192),
  expires_at: z.number().int().positive(),
});

let activeOperation: AbortController | undefined;
let disabledDocument: Document | undefined;

function readSdk() {
  const sdk: unknown = Reflect.get(window, 'watchwood');
  const parsed = sdkSchema.safeParse(sdk);
  return parsed.success ? parsed.data : undefined;
}

async function loadSdk(signal: AbortSignal) {
  const sdk = readSdk();
  if (sdk) return sdk;

  const script = document.createElement('script');
  script.id = scriptId;
  script.src = sdkUrl;
  script.async = true;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      script.removeEventListener('load', onLoad);
      script.removeEventListener('error', onError);
      signal.removeEventListener('abort', onError);
    };
    const onLoad = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      script.remove();
      reject(new Error('Watchwood unavailable'));
    };
    script.addEventListener('load', onLoad, { once: true });
    script.addEventListener('error', onError, { once: true });
    signal.addEventListener('abort', onError, { once: true });
    document.head.appendChild(script);
  });

  signal.throwIfAborted();
  const loadedSdk = readSdk();
  if (!loadedSdk) script.remove();
  return loadedSdk;
}

async function performWatchwoodSignup(signal: AbortSignal, submit: boolean): Promise<void> {
  const response = await fetch('/api/auth/watchwood', {
    cache: 'no-store',
    credentials: 'same-origin',
    signal,
  });
  if (!response.ok) return;
  const body: unknown = await response.json();
  signal.throwIfAborted();
  const context = contextSchema.safeParse(body);
  if (!context.success) return;
  disabledDocument = context.data.enabled ? undefined : document;
  if (!context.data.enabled) return;

  const { org_id, safety_identifier } = context.data;
  const sdk = await loadSdk(signal);
  signal.throwIfAborted();
  if (!sdk) return;
  await sdk.initialize({ org_id, safety_identifier });
  signal.throwIfAborted();
  if (!submit) return;

  let token = '';
  try {
    const result = tokenSchema.safeParse(await sdk.getToken());
    if (result.success && result.data.expires_at * 1000 > Date.now()) {
      token = result.data.token;
    }
  } catch {
    token = '';
  }
  signal.throwIfAborted();
  await fetch('/api/auth/watchwood', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ token, safety_identifier }),
    signal,
  });
}

async function runWatchwoodSignup(submit: boolean): Promise<void> {
  if (typeof window === 'undefined') return;
  activeOperation?.abort();
  const controller = new AbortController();
  activeOperation = controller;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const aborted = new Promise<void>(resolve => {
    controller.signal.addEventListener('abort', () => resolve(), { once: true });
  });
  try {
    await Promise.race([performWatchwoodSignup(controller.signal, submit), aborted]);
  } catch {
    return;
  } finally {
    clearTimeout(timeout);
    controller.abort();
    if (activeOperation === controller) activeOperation = undefined;
  }
}

export async function prepareWatchwoodSignup(): Promise<void> {
  disabledDocument = undefined;
  await runWatchwoodSignup(false);
}

export async function submitWatchwoodSignup(): Promise<void> {
  if (typeof document !== 'undefined' && disabledDocument === document) return;
  await runWatchwoodSignup(true);
}
