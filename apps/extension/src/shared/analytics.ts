import { PostHog } from 'posthog-js/dist/module.no-external';
import { z } from 'zod';

export const EXTENSION_SIGNED_IN_EVENT = 'extension_signed_in';
export const EXTENSION_SIGNED_OUT_EVENT = 'extension_signed_out';
export const CONVERSATION_CREATED_EVENT = 'conversation_created';
export const MESSAGE_SENT_EVENT = 'message_sent';
/** Daily heartbeat: at most one per signed-in user per local day, on panel open. */
export const EXTENSION_ACTIVE_EVENT = 'extension_active';

export const ANALYTICS_OPT_OUT_STORAGE_KEY = 'sync:analyticsOptOut';
export const ANALYTICS_LAST_ACTIVE_DAY_STORAGE_KEY = 'local:analyticsLastActiveDay';

/** Super property that separates extension traffic from web/CLI/mobile in PostHog. */
export const ANALYTICS_SURFACE = 'browser_extension';

type MaybePromise<Value> = Promise<Value> | Value;

export interface AnalyticsStorageArea {
  getItem(key: string): MaybePromise<unknown>;
  setItem(key: string, value: unknown): MaybePromise<void>;
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

interface AnalyticsSurfaceContext {
  readonly browser: 'chrome' | 'firefox';
  readonly extensionVersion: string | undefined;
}

const publishIdentity = (
  client: PostHog,
  email: string,
  context: AnalyticsSurfaceContext
): void => {
  const superProperties: Record<string, string> = {
    browser: context.browser,
    platform: 'extension',
    surface: ANALYTICS_SURFACE,
  };

  if (context.extensionVersion !== undefined) {
    superProperties['extension_version'] = context.extensionVersion;
  }

  client.register(superProperties);
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

type ExtensionVersionReader = () => MaybePromise<string | undefined>;

// eslint-disable-next-line unicorn/no-useless-undefined -- explicit unset sentinel
let extensionVersionReader: ExtensionVersionReader | undefined = undefined;

/** Test-only seam for the manifest version read under Vitest (node, no browser.runtime). */
export const __setExtensionVersionReaderForTests = (reader?: ExtensionVersionReader): void => {
  extensionVersionReader = reader;
};

/**
 * Reads the shipped extension version for the `extension_version` super property.
 * Resolves `undefined` (property omitted) rather than failing startup when the
 * manifest is unreadable.
 */
const readExtensionVersion = async (): Promise<string | undefined> => {
  try {
    const raw: unknown = await (async () => {
      if (extensionVersionReader) {
        return extensionVersionReader();
      }
      const { browser } = await import('wxt/browser');
      return browser.runtime.getManifest().version;
    })();

    return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
  } catch {
    return undefined;
  }
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
  const extensionVersion = await readExtensionVersion();

  if (lifecycleEpoch !== epochAtStart) {
    // Discard without identify — inert with flags/capture disabled.
    dropClient(client);
    return false;
  }

  publishIdentity(client, email, {
    browser: isFirefoxBuild() ? 'firefox' : 'chrome',
    extensionVersion,
  });
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

/** Local calendar day (not UTC): a user's WAU must not turn over at their midnight-UTC. */
const toLocalDay = (date: Date): string => {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const dayOfMonth = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${dayOfMonth}`;
};

/**
 * FNV-1a marker for the signed-in email, so a stored day belongs to one user
 * without putting the address itself into extension storage. Two accounts on one
 * browser profile must both count.
 */
const emailMarker = (email: string): string => {
  let hash = 0x81_1c_9d_c5;
  for (let index = 0; index < email.length; index += 1) {
    hash ^= email.codePointAt(index) ?? 0;
    hash = Math.imul(hash, 0x01_00_01_93) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

// eslint-disable-next-line unicorn/no-useless-undefined -- explicit unset sentinel
let activeCaptureInFlight: Promise<boolean> | undefined = undefined;

const readStoredDay = async (storageArea: AnalyticsStorageArea): Promise<unknown> => {
  try {
    return await storageArea.getItem(ANALYTICS_LAST_ACTIVE_DAY_STORAGE_KEY);
  } catch {
    // Analytics must never break the panel; an unreadable day just means "send".
    return undefined;
  }
};

const writeStoredDay = async (storageArea: AnalyticsStorageArea, value: string): Promise<void> => {
  try {
    await storageArea.setItem(ANALYTICS_LAST_ACTIVE_DAY_STORAGE_KEY, value);
  } catch {
    // Quota or a detached storage context: the heartbeat still counts.
  }
};

/**
 * Captures `extension_active` at most once per signed-in user per local day.
 *
 * The day (with a per-user marker) is persisted BEFORE the capture so a crash
 * mid-flush cannot produce a second heartbeat for the same day; the trade-off (a
 * dropped heartbeat if the browser dies at that instant) is the correct one for
 * an at-most-once counter. Resolves `false` without writing when analytics is not
 * active, so a signed-out or opted-out open never burns the day.
 */
export const captureDailyActive = async (
  storageArea: AnalyticsStorageArea,
  now: Date = new Date()
): Promise<boolean> => {
  const identity = activeIdentity;

  if (identity === undefined) {
    return false;
  }

  if (activeCaptureInFlight !== undefined) {
    return activeCaptureInFlight;
  }

  const run = (async (): Promise<boolean> => {
    const expected = `${toLocalDay(now)}:${emailMarker(identity.email)}`;
    const previous = await readStoredDay(storageArea);

    if (previous === expected) {
      return false;
    }

    // A sign-out or opt-out can land while the read above is in flight.
    if (activeIdentity === undefined) {
      return false;
    }

    await writeStoredDay(storageArea, expected);
    captureEvent(EXTENSION_ACTIVE_EVENT, {}, { sendInstantly: true });
    return true;
  })();

  activeCaptureInFlight = run;

  try {
    return await run;
  } finally {
    activeCaptureInFlight = undefined;
  }
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
