import { z } from 'zod';
export declare const WastelandConfigRecord: z.ZodObject<{
    wasteland_id: z.ZodString;
    name: z.ZodString;
    owner_type: z.ZodEnum<{
        org: "org";
        user: "user";
    }>;
    owner_user_id: z.ZodNullable<z.ZodString>;
    organization_id: z.ZodNullable<z.ZodString>;
    dolthub_upstream: z.ZodNullable<z.ZodString>;
    visibility: z.ZodEnum<{
        private: "private";
        public: "public";
    }>;
    status: z.ZodEnum<{
        active: "active";
        deleted: "deleted";
    }>;
    created_at: z.ZodString;
    updated_at: z.ZodString;
}, z.core.$strip>;
export type WastelandConfigRecord = z.output<typeof WastelandConfigRecord>;
export declare const wasteland_config: import("../../util/table").TableQueryInterpolator<{
    name: "wasteland_config";
    columns: ("created_at" | "dolthub_upstream" | "name" | "organization_id" | "owner_type" | "owner_user_id" | "status" | "updated_at" | "visibility" | "wasteland_id")[];
}>;
export declare function createTableWastelandConfig(): string;
