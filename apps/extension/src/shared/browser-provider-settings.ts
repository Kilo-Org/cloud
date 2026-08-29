import {
  BROWSER_FRAME_MAX_BYTES,
  browserProviderIdSchema,
} from '@kilocode/cloud-agent-sdk/schemas';
import { z } from 'zod';
import type { BrowserExecutionLease } from '../../entrypoints/sidepanel/browser-execution-lock';
import { agentMemorySettingsSchema } from './agent-memory-settings';
import { agentWorkflowSettingsSchema } from './agent-workflows';
import {
  AUTH_STORAGE_KEY,
  BROWSER_PROVIDER_IDENTITY_KEY,
  normalizeStoredAuth,
  withBrowserProfileStorageLock,
} from './auth';
import type { StoredAuth } from './auth';
import { normalizeRemoteMcpStore } from './remote-mcp-storage';
import { webMcpSettingsSchema } from './web-mcp-settings';

export const BROWSER_PROVIDER_SETTINGS_KEY = 'local:kiloBrowserProviderSettings';

export type BrowserPersistenceCode =
  | 'storage_failure'
  | 'owner_mismatch'
  | 'model_required'
  | 'unsupported'
  | 'invalid_request'
  | 'invocation_expired'
  | 'invocation_conflict'
  | 'conversation_busy'
  | 'not_found'
  | 'capacity_exceeded';

export class BrowserPersistenceError extends Error {
  readonly code: BrowserPersistenceCode;
  readonly retryable: boolean;

  constructor(code: BrowserPersistenceCode, message: string) {
    super(message);
    this.name = 'BrowserPersistenceError';
    this.code = code;
    this.retryable = code === 'storage_failure' || code === 'capacity_exceeded';
  }
}

// eslint-disable-next-line typescript/consistent-type-definitions -- Repository guidance prefers type declarations.
export type BrowserProfileStorage = {
  // eslint-disable-next-line anti-slop/no-unknown-returns -- Each consumer validates the raw persisted value at its storage boundary.
  getItem: (key: `local:${string}`) => unknown;
  setItem: (key: `local:${string}`, value: unknown) => void | Promise<void>;
};
// eslint-disable-next-line typescript/consistent-type-definitions -- Repository guidance prefers type declarations.
export type BrowserProfileContext = {
  readonly auth: StoredAuth;
  readonly owner: BrowserExecutionLease;
  readonly storageArea: BrowserProfileStorage;
};

const labelSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine(value => new TextEncoder().encode(value).byteLength <= 128);
const identitySchema = z.strictObject({
  label: labelSchema,
  providerId: browserProviderIdSchema,
  providerProof: z.string().regex(/^[a-f0-9]{64}$/u),
  version: z.literal(1),
});
export type BrowserProviderIdentity = z.infer<typeof identitySchema>;

export const browserProviderSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  mode: z.enum(['safe', 'dangerous']),
  model: z.string().trim().max(1024),
  thinkingEffort: z.string().max(128),
});
export type BrowserProviderSettings = z.infer<typeof browserProviderSettingsSchema>;
const settingsRecordSchema = z.strictObject({
  accountKey: z.string().min(1),
  settings: browserProviderSettingsSchema,
  version: z.literal(1),
});
const defaultSettings = (): BrowserProviderSettings => ({
  enabled: false,
  mode: 'safe',
  model: '',
  thinkingEffort: '',
});

export const browserApprovalSettingsSchema = z.strictObject({
  memorySettings: agentMemorySettingsSchema,
  mode: z.enum(['safe', 'dangerous']),
  model: z.string().trim().min(1).max(1024),
  organizationId: z.string().min(1).max(128).nullable(),
  remoteMcpServers: z
    .array(z.unknown())
    .transform(servers => normalizeRemoteMcpStore({ servers }).servers),
  thinkingEffort: z.string().max(128),
  webMcpSettings: webMcpSettingsSchema,
  workflowSettings: agentWorkflowSettingsSchema,
});
export type BrowserApprovalSettings = z.infer<typeof browserApprovalSettingsSchema>;

const hex = (bytes: Uint8Array): string =>
  [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

export const browserAccountKey = async (auth: StoredAuth): Promise<string> => {
  // Older auth records can lack an email. Keep token-scoped isolation until those records retire.
  const identity = auth.userEmail === undefined ? `token:${auth.token}` : `email:${auth.userEmail}`;
  return hex(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity)))
  );
};

/** Auth cleanup uses the same write lock; a stopped owner cannot restore cleared account data. */
export const withBrowserProfileStorage = <Result>(
  context: BrowserProfileContext,
  work: (accountKey: string) => Promise<Result>
): Promise<Result> =>
  withBrowserProfileStorageLock(async () => {
    const assertOwner = (): void => {
      try {
        if (context.owner.kind !== 'provider') {
          throw new Error('Provider ownership required.');
        }
        context.owner.guard();
      } catch {
        throw new BrowserPersistenceError(
          'owner_mismatch',
          'This panel no longer owns the browser provider.'
        );
      }
    };
    try {
      assertOwner();
      const auth = normalizeStoredAuth(await context.storageArea.getItem(AUTH_STORAGE_KEY));
      if (auth?.token !== context.auth.token || auth.userEmail !== context.auth.userEmail) {
        throw new BrowserPersistenceError(
          'owner_mismatch',
          'The signed-in account changed. Browser work cannot resume.'
        );
      }
      const accountKey = await browserAccountKey(auth);
      assertOwner();
      const result = await work(accountKey);
      assertOwner();
      return result;
    } catch (error) {
      if (error instanceof BrowserPersistenceError) {
        throw error;
      }
      // Storage and validation errors can include private settings. Never forward their raw text.
      throw new BrowserPersistenceError(
        'storage_failure',
        'Browser task storage is unavailable. No unrecorded work can start. Restore storage access and retry.'
      );
    }
  });

export const loadBrowserProvider = (context: BrowserProfileContext) =>
  withBrowserProfileStorage(context, async accountKey => {
    const rawIdentity = await context.storageArea.getItem(BROWSER_PROVIDER_IDENTITY_KEY);
    const missingIdentity = rawIdentity === null || rawIdentity === undefined;
    const providerId = missingIdentity ? `bp_${crypto.randomUUID()}` : undefined;
    const identity = identitySchema.parse(
      rawIdentity ?? {
        label: `Browser profile ${providerId?.slice(3, 11)}`,
        providerId,
        providerProof: hex(crypto.getRandomValues(new Uint8Array(32))),
        version: 1,
      }
    );
    if (missingIdentity) {
      context.owner.guard();
      await context.storageArea.setItem(BROWSER_PROVIDER_IDENTITY_KEY, identity);
    }
    const rawSettings = await context.storageArea.getItem(BROWSER_PROVIDER_SETTINGS_KEY);
    const record =
      rawSettings === null || rawSettings === undefined
        ? undefined
        : settingsRecordSchema.parse(rawSettings);
    const settings = record?.accountKey === accountKey ? record.settings : defaultSettings();
    if (settings.enabled && settings.model.length === 0) {
      throw new BrowserPersistenceError(
        'model_required',
        'Select a model before enabling CLI tasks.'
      );
    }
    if (record?.accountKey !== accountKey) {
      context.owner.guard();
      await context.storageArea.setItem(BROWSER_PROVIDER_SETTINGS_KEY, {
        accountKey,
        settings,
        version: 1,
      });
    }
    return { identity, settings };
  });

export const saveBrowserProviderSettings = (
  context: BrowserProfileContext,
  settings: BrowserProviderSettings
): Promise<BrowserProviderSettings> =>
  withBrowserProfileStorage(context, async accountKey => {
    const parsed = browserProviderSettingsSchema.parse(settings);
    if (parsed.enabled && parsed.model.length === 0) {
      throw new BrowserPersistenceError(
        'model_required',
        'Select a model before enabling CLI tasks.'
      );
    }
    context.owner.guard();
    await context.storageArea.setItem(BROWSER_PROVIDER_SETTINGS_KEY, {
      accountKey,
      settings: parsed,
      version: 1,
    });
    return parsed;
  });

export const saveBrowserProviderLabel = (
  context: BrowserProfileContext,
  label: string
): Promise<BrowserProviderIdentity> =>
  withBrowserProfileStorage(context, async () => {
    const identity = identitySchema.parse(
      await context.storageArea.getItem(BROWSER_PROVIDER_IDENTITY_KEY)
    );
    const updated = { ...identity, label: labelSchema.parse(label) };
    context.owner.guard();
    await context.storageArea.setItem(BROWSER_PROVIDER_IDENTITY_KEY, updated);
    return updated;
  });

const jsonSchema = z.json();
/** Reject non-JSON values rather than silently dropping evidence or tool output. */
export const browserRecordBytes = (value: unknown): number => {
  try {
    return new TextEncoder().encode(JSON.stringify(jsonSchema.parse(value))).byteLength;
  } catch {
    throw new BrowserPersistenceError(
      'invalid_request',
      'Browser task data must be JSON-serializable. No unrecorded work can start.'
    );
  }
};

export const assertBrowserRecordSize = (value: unknown, reservedBytes = 0): void => {
  if (browserRecordBytes(value) + reservedBytes >= BROWSER_FRAME_MAX_BYTES) {
    throw new BrowserPersistenceError(
      'storage_failure',
      'Browser task data exceeds the storage limit. No unrecorded work can start.'
    );
  }
};
