import type { RegistryDO } from './dos/RegistryDO';
import type { SignerDO } from './dos/SignerDO';
import type { StreamDO } from './dos/StreamDO';
import type { VerifierDO } from './dos/VerifierDO';
import type { SecretsEnv } from './secrets';

/** `AUDIT_ENVIRONMENT` of the deployment; STS serves the bundle for the matching environment. */
export const AUDIT_ENVIRONMENTS = ['production', 'staging', 'local'] as const;
export type AuditEnvironment = (typeof AUDIT_ENVIRONMENTS)[number];

export type Env = SecretsEnv & {
  AUDIT_ARCHIVE: R2Bucket;
  AUDIT_STREAM: DurableObjectNamespace<StreamDO>;
  AUDIT_REGISTRY: DurableObjectNamespace<RegistryDO>;
  AUDIT_SIGNER: DurableObjectNamespace<SignerDO>;
  AUDIT_VERIFIER: DurableObjectNamespace<VerifierDO>;
  AXIOM_DATASET: string;
  AXIOM_URL: string;
  /** Test-only override of `VERIFY_SLICE_OBJECTS`; no deployed environment sets it. */
  AUDIT_VERIFY_SLICE_OBJECTS?: string;
  AUDIT_ENVIRONMENT: AuditEnvironment;
};
