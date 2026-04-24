import { z } from 'zod';
export declare const WastelandRegistryRecord: z.ZodObject<{
    wasteland_id: z.ZodString;
    owner_type: z.ZodEnum<{
        org: "org";
        user: "user";
    }>;
    owner_user_id: z.ZodNullable<z.ZodString>;
    organization_id: z.ZodNullable<z.ZodString>;
    name: z.ZodString;
    created_at: z.ZodString;
}, z.core.$strip>;
export type WastelandRegistryRecord = z.output<typeof WastelandRegistryRecord>;
export declare const wasteland_registry: import("../../util/table").TableQueryInterpolator<{
    name: "wasteland_registry";
    columns: ("created_at" | "name" | "organization_id" | "owner_type" | "owner_user_id" | "wasteland_id")[];
}>;
export declare function createTableWastelandRegistry(): string;
