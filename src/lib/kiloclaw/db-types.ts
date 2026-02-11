/**
 * Per-channel config stored as JSONB. Opaque to Postgres —
 * the DO decrypts tokens at container startup.
 */
export type KiloClawInstanceChannels = Record<string, unknown>;

/**
 * A single env var or secret stored in the vars JSONB array.
 * Follows the same pattern as agent_environment_profile_vars.
 */
export type KiloClawInstanceVar = {
  key: string;
  value: string; // plaintext if is_secret=false, JSON-serialized EncryptedEnvelope if is_secret=true
  is_secret: boolean;
};
