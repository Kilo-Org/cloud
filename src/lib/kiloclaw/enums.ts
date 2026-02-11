// KiloClawInstanceStatus removed — operational state lives in the DO only.
// These types are used by the Postgres schema for the backup columns.

/** Per-channel config stored as JSONB. Opaque to Postgres. */
export type KiloClawInstanceChannels = Record<string, unknown>;

/** A single env var or secret in the vars JSONB array. */
export type KiloClawInstanceVar = {
  key: string;
  value: string;
  is_secret: boolean;
};
