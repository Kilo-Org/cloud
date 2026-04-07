// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type KeyChange = {
  key: string;
  oldValue: string | undefined;
  newValue: string;
};

type DevVarsFileChange = {
  workerDir: string;
  isNew: boolean;
  keyChanges: KeyChange[];
  missingValues: string[];
  // Full content only used for new files; existing files are patched in-place
  newFileContent: string | undefined;
};

type EnvDevLocalChange = {
  key: string;
  oldValue: string | undefined;
  newValue: string;
};

type SecretStoreBinding = {
  binding: string;
  store_id: string;
  secret_name: string;
};

type SecretStoreWarning = {
  workerDir: string;
  bindings: SecretStoreBinding[];
};

type ConsistencyWarning = {
  sourceKey: string;
  entries: { workerDir: string; workerKey: string; value: string }[];
};

type SecretStoreAutoCreate = {
  workerDir: string;
  binding: SecretStoreBinding;
  envLocalKey: string;
  value: string;
};

type EnvSyncPlan = {
  lanIp: string | undefined;
  devVarsChanges: DevVarsFileChange[];
  envDevLocalChanges: EnvDevLocalChange[];
  secretStoreWarnings: SecretStoreWarning[];
  secretStoreAutoCreates: SecretStoreAutoCreate[];
  consistencyWarnings: ConsistencyWarning[];
  missingEnvLocal: boolean;
};

// ---------------------------------------------------------------------------
// Annotation types
// ---------------------------------------------------------------------------

type Annotation =
  | { type: 'passthrough' }
  | { type: 'from'; envLocalKey: string }
  | { type: 'url'; services: { name: string; path?: string }[] }
  | { type: 'pkcs8' };

type ExampleEntry = {
  key: string;
  defaultValue: string;
  annotation: Annotation;
};

// ---------------------------------------------------------------------------
// Public API result types
// ---------------------------------------------------------------------------

type SyncResult = {
  ok: boolean;
  changed: number;
  missing: number;
};

type CheckResult = {
  ok: boolean;
  envLocalExists: boolean;
  missing: number;
  workerCount: number;
};

export type {
  KeyChange,
  DevVarsFileChange,
  EnvDevLocalChange,
  SecretStoreBinding,
  SecretStoreWarning,
  SecretStoreAutoCreate,
  ConsistencyWarning,
  EnvSyncPlan,
  Annotation,
  ExampleEntry,
  SyncResult,
  CheckResult,
};
