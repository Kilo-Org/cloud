// Zod Schemas
export {
  SecretCategorySchema,
  SecretIconKeySchema,
  InjectionMethodSchema,
  SecretFieldDefinitionSchema,
  SecretCatalogEntrySchema,
} from './types';

// Types
export type {
  SecretCategory,
  SecretIconKey,
  InjectionMethod,
  SecretFieldDefinition,
  SecretCatalogEntry,
} from './types';

export { DEFAULT_INJECTION_METHOD, getInjectionMethod } from './types';

// Catalog and lookup helpers
export {
  SECRET_CATALOG,
  SECRET_CATALOG_MAP,
  ALL_SECRET_FIELD_KEYS,
  FIELD_KEY_TO_ENV_VAR,
  ENV_VAR_TO_FIELD_KEY,
  FIELD_KEY_TO_ENTRY,
  ALL_SECRET_ENV_VARS,
  MAX_SECRET_FIELD_LENGTH,
  INTERNAL_SENSITIVE_ENV_VARS,
  getEntriesByCategory,
  getFieldKeysByCategory,
  // Custom secret helpers
  MAX_CUSTOM_SECRETS,
  MAX_CUSTOM_SECRET_VALUE_LENGTH,
  isValidCustomSecretKey,
  isCustomSecretEnvVar,
  isValidConfigPath,
  getAllowedConfigPathPatterns,
} from './catalog';

export type { SecretFieldKey } from './catalog';

// Validation
export { validateFieldValue } from './validation';
