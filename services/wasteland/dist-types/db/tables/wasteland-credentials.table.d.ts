import { z } from 'zod';
export declare const WastelandCredentialRecord: z.ZodObject<{
    user_id: z.ZodString;
    wasteland_id: z.ZodString;
    encrypted_token: z.ZodString;
    dolthub_org: z.ZodString;
    rig_handle: z.ZodNullable<z.ZodString>;
    is_upstream_admin: z.ZodPipe<z.ZodUnion<readonly [z.ZodBoolean, z.ZodNumber, z.ZodNull]>, z.ZodTransform<boolean, number | boolean | null>>;
    connected_at: z.ZodString;
}, z.core.$strip>;
export type WastelandCredentialRecord = z.output<typeof WastelandCredentialRecord>;
export declare const wasteland_credentials: import("../../util/table").TableQueryInterpolator<{
    name: "wasteland_credentials";
    columns: ("connected_at" | "dolthub_org" | "encrypted_token" | "is_upstream_admin" | "rig_handle" | "user_id" | "wasteland_id")[];
}>;
export declare function createTableWastelandCredentials(): string;
/**
 * Idempotent migration that adds `is_upstream_admin` to existing rows.
 * Safe to call on every DO init — SQLite's ALTER TABLE IF NOT EXISTS
 * isn't available, so we catch the "duplicate column" error via a
 * presence check.
 */
export declare function migrateAddIsUpstreamAdmin(sql: SqlStorage): void;
