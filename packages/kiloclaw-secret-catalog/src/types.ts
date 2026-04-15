import { z } from 'zod';

// --- Zod Schemas ---

export const SecretCategorySchema = z.enum(['channel', 'tool', 'provider', 'custom']);

export const SecretIconKeySchema = z.enum([
  'send',
  'discord',
  'slack',
  'key',
  'github',
  'linear',
  'credit-card',
  'lock',
  'brave',
]);

/**
 * How a secret is delivered to the OpenClaw process at runtime.
 *
 * - 'env': The worker encrypts the secret value and sets it as a
 *   KILOCLAW_ENC_* env var on the Fly machine. At boot, the controller's
 *   bootstrap decrypts the env var, then patches the plaintext value into
 *   the appropriate location in openclaw.json
 *   (e.g., config.channels.telegram.botToken). OpenClaw reads from
 *   openclaw.json at startup — it never reads these env vars directly.
 *
 * - 'openclaw-secrets': (future) Use OpenClaw's native secret management
 *   via `openclaw secrets set` / SecretRef. Secrets are injected directly
 *   by OpenClaw without the env var + boot script patching roundtrip.
 *   See: https://github.com/openclaw/openclaw/issues/33702
 */
export const InjectionMethodSchema = z.enum(['env', 'openclaw-secrets']);

export const SecretFieldDefinitionSchema = z
  .object({
    key: z.string(), // storage key (e.g. 'telegramBotToken')
    label: z.string(), // UI label
    placeholder: z.string(),
    placeholderConfigured: z.string(),
    validationPattern: z.string().optional(), // regex string (not RegExp — must be serializable)
    validationMessage: z.string().optional(),
    envVar: z.string(), // container env var name
    maxLength: z.number().int().positive(), // max input length
    requiredForConfigured: z.boolean().optional(), // omit = true
  })
  .readonly();

export const SecretCatalogEntrySchema = z
  .object({
    id: z.string(), // e.g. 'telegram', 'brave-search'
    label: z.string(),
    category: SecretCategorySchema,
    icon: SecretIconKeySchema, // typed union, resolved to React component at UI layer
    fields: z.array(SecretFieldDefinitionSchema).readonly(),
    helpText: z.string().optional(),
    helpUrl: z.url().optional(),
    guideText: z.string().optional(),
    guideUrl: z.url().optional(),
    allFieldsRequired: z.boolean().optional(), // e.g. Slack needs both bot + app tokens
    order: z.number().int().optional(), // sort within category (undefined sorts last)
    injectionMethod: InjectionMethodSchema.optional(), // omit = use DEFAULT_INJECTION_METHOD
  })
  .readonly();

// --- Derived Types (preserves literal inference via as const satisfies) ---

export type SecretCategory = z.infer<typeof SecretCategorySchema>;

export type SecretIconKey = z.infer<typeof SecretIconKeySchema>;

export type InjectionMethod = z.infer<typeof InjectionMethodSchema>;

export type SecretFieldDefinition = z.infer<typeof SecretFieldDefinitionSchema>;

export type SecretCatalogEntry = z.infer<typeof SecretCatalogEntrySchema>;

// Global default — all entries use 'env' unless individually overridden
export const DEFAULT_INJECTION_METHOD: InjectionMethod = 'env';

// Resolution helper
export function getInjectionMethod(entry: SecretCatalogEntry): InjectionMethod {
  return entry.injectionMethod ?? DEFAULT_INJECTION_METHOD;
}
