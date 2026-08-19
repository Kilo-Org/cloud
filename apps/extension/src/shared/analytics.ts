import { PostHog } from 'posthog-js/dist/module.no-external';
import { z } from 'zod';

export const EXTENSION_SIGNED_IN_EVENT = 'extension_signed_in';
export const EXTENSION_SIGNED_OUT_EVENT = 'extension_signed_out';
export const CONVERSATION_CREATED_EVENT = 'conversation_created';
export const MESSAGE_SENT_EVENT = 'message_sent';

export const ANALYTICS_OPT_OUT_STORAGE_KEY = 'sync:analyticsOptOut';

type MaybePromise<Value> = Promise<Value> | Value;

export interface AnalyticsStorageArea {
  getItem(key: typeof ANALYTICS_OPT_OUT_STORAGE_KEY): MaybePromise<unknown>;
  setItem(key: typeof ANALYTICS_OPT_OUT_STORAGE_KEY, value: boolean): MaybePromise<void>;
}

interface AnalyticsGateInput {
  readonly firefoxUsageDataGranted: boolean;
  readonly hasApiKey: boolean;
  readonly hasEmail: boolean;
  readonly isDev: boolean;
  readonly optedOut: boolean;
}

interface CaptureEventOptions {
  readonly sendInstantly?: boolean;
}

interface ResetAnalyticsUserOptions {
  readonly reason: 'explicit' | 'expired';
}

interface ActiveAnalyticsIdentity {
  readonly client: PostHog;
  readonly email: string;
}

const POSTHOG_API_HOST = 'https://us.i.posthog.com';

// Exact MV3-safe init option set from the plan (key order sorted for lint).
const POSTHOG_INIT_OPTIONS = {
  advanced_disable_flags: true,
  api_host: POSTHOG_API_HOST,
  autocapture: false,
  capture_pageleave: false,
  capture_pageview: false,
  disable_external_dependency_loading: true,
  disable_session_recording: true,
  persistence: 'localStorage',
} as const;

const permissionsGetAllSchema = z
  .object({
    data_collection: z.array(z.string()).optional(),
  })
  .loose();

// eslint-disable-next-line unicorn/no-useless-undefined -- explicit unset sentinel
let activeIdentity: ActiveAnalyticsIdentity | undefined = undefined;
let lifecycleEpoch = 0;

const readApiKey = (): string | undefined => {
  const key = import.meta.env.VITE_POSTHOG_API_KEY;
  return key !== undefined && key.trim().length > 0 ? key.trim() : undefined;
};

const createPostHogClient = (apiKey: string): PostHog => {
  const client = new PostHog();
  client.init(apiKey, { ...POSTHOG_INIT_OPTIONS });
  return client;
};

const dropClient = (client: PostHog | undefined): void => {
  client?.reset();
};

const publishIdentity = (client: PostHog, email: string): void => {
  client.register({ platform: 'extension' });
  client.identify(email, { email });
  activeIdentity = { client, email };
};

export const shouldStartAnalytics = ({
  firefoxUsageDataGranted,
  hasApiKey,
  hasEmail,
  isDev,
  optedOut,
}: AnalyticsGateInput): boolean =>
  !isDev && hasApiKey && hasEmail && !optedOut && firefoxUsageDataGranted;

export const loadAnalyticsOptOut = async (storageArea: AnalyticsStorageArea): Promise<boolean> => {
  const value = await storageArea.getItem(ANALYTICS_OPT_OUT_STORAGE_KEY);
  return value === true;
};

type FirefoxPermissionsReader = () => MaybePromise<unknown>;

// eslint-disable-next-line unicorn/no-useless-undefined -- explicit unset sentinel
let firefoxPermissionsReader: FirefoxPermissionsReader | undefined = undefined;

/** Test-only seam for Firefox permission reads under Vitest (node, no chrome global). */
export const __setFirefoxPermissionsReaderForTests = (reader?: FirefoxPermissionsReader): void => {
  firefoxPermissionsReader = reader;
};

const readFirefoxPermissions = async (): Promise<z.infer<
  typeof permissionsGetAllSchema
> | null> => {
  const raw = await (async () => {
    if (firefoxPermissionsReader) {
      return firefoxPermissionsReader();
    }
    const { browser } = await import('wxt/browser');
    return browser.permissions.getAll();
  })();

  const parsed = permissionsGetAllSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

const isTruthyEnvFlag = (value: unknown): boolean => value === true || value === 'true';

// Vite injects DEV; WXT injects FIREFOX as a boolean. Vitest stubs non-DEV keys as strings.
const isDevBuild = (): boolean => isTruthyEnvFlag(import.meta.env.DEV);

const isFirefoxBuild = (): boolean => isTruthyEnvFlag(import.meta.env.FIREFOX);

export const getFirefoxUsageDataGranted = async (): Promise<boolean> => {
  if (!isFirefoxBuild()) {
    return true;
  }

  const parsed = await readFirefoxPermissions();
  if (parsed === null) {
    return false;
  }

  const dataCollection = parsed.data_collection;
  if (dataCollection === undefined) {
    // Firefox < 140: no built-in data_collection consent surface.
    return false;
  }

  return dataCollection.includes('technicalAndInteraction');
};

export const initAnalytics = async (
  storageArea: AnalyticsStorageArea,
  email: string
): Promise<boolean> => {
  const epochAtStart = ++lifecycleEpoch;

  if (activeIdentity !== undefined) {
    if (activeIdentity.email === email) {
      return true;
    }

    // Re-identify without constructing a second client.
    activeIdentity.client.identify(email, { email });
    activeIdentity = { client: activeIdentity.client, email };
    return true;
  }

  const apiKey = readApiKey();
  const hasApiKey = apiKey !== undefined;
  const hasEmail = email.trim().length > 0;

  if (!hasApiKey) {
    console.info('PostHog analytics disabled: VITE_POSTHOG_API_KEY is not set.');
  }

  const optedOut = await loadAnalyticsOptOut(storageArea);
  const firefoxUsageDataGranted = await getFirefoxUsageDataGranted();

  if (lifecycleEpoch !== epochAtStart) {
    return false;
  }

  const canStart = shouldStartAnalytics({
    firefoxUsageDataGranted,
    hasApiKey,
    hasEmail,
    isDev: isDevBuild(),
    optedOut,
  });

  if (!canStart || apiKey === undefined) {
    return false;
  }

  const client = createPostHogClient(apiKey);

  if (lifecycleEpoch !== epochAtStart) {
    // Discard without identify — inert with flags/capture disabled.
    dropClient(client);
    return false;
  }

  publishIdentity(client, email);
  return true;
};

export const captureEvent = (
  name: string,
  properties?: Record<string, string | number | boolean>,
  options?: CaptureEventOptions
): void => {
  if (activeIdentity === undefined) {
    return;
  }

  if (options?.sendInstantly === true) {
    activeIdentity.client.capture(name, properties, { send_instantly: true });
    return;
  }

  activeIdentity.client.capture(name, properties);
};

export const resetAnalyticsUser = ({ reason }: ResetAnalyticsUserOptions): Promise<void> => {
  lifecycleEpoch += 1;
  const current = activeIdentity;
  activeIdentity = undefined;

  if (current !== undefined) {
    current.client.capture(EXTENSION_SIGNED_OUT_EVENT, { reason }, { send_instantly: true });
    current.client.reset();
    return Promise.resolve();
  }

  const apiKey = readApiKey();
  if (apiKey === undefined) {
    return Promise.resolve();
  }

  // Scrub stale ph_<token>_* localStorage identity from a prior session.
  const ephemeral = createPostHogClient(apiKey);
  ephemeral.reset();
  return Promise.resolve();
};

export const setAnalyticsOptOut = async (
  storageArea: AnalyticsStorageArea,
  optedOut: boolean,
  identity?: { readonly email: string }
): Promise<void> => {
  lifecycleEpoch += 1;
  await storageArea.setItem(ANALYTICS_OPT_OUT_STORAGE_KEY, optedOut);

  if (optedOut) {
    const current = activeIdentity;
    activeIdentity = undefined;
    current?.client.reset();
    return;
  }

  if (identity !== undefined) {
    await initAnalytics(storageArea, identity.email);
  }
};
