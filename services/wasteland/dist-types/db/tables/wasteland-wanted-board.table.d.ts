import { z } from 'zod';
export declare const WastelandWantedBoardRecord: z.ZodObject<{
    item_id: z.ZodString;
    wasteland_id: z.ZodString;
    title: z.ZodString;
    description: z.ZodString;
    status: z.ZodEnum<{
        claimed: "claimed";
        done: "done";
        open: "open";
    }>;
    priority: z.ZodEnum<{
        critical: "critical";
        high: "high";
        low: "low";
        medium: "medium";
    }>;
    type: z.ZodEnum<{
        bug: "bug";
        docs: "docs";
        feature: "feature";
        other: "other";
    }>;
    claimed_by: z.ZodNullable<z.ZodString>;
    evidence: z.ZodNullable<z.ZodString>;
    created_at: z.ZodString;
    updated_at: z.ZodString;
}, z.core.$strip>;
export type WastelandWantedBoardRecord = z.output<typeof WastelandWantedBoardRecord>;
export declare const wasteland_wanted_board: import("../../util/table").TableQueryInterpolator<{
    name: "wasteland_wanted_board";
    columns: ("claimed_by" | "created_at" | "description" | "evidence" | "item_id" | "priority" | "status" | "title" | "type" | "updated_at" | "wasteland_id")[];
}>;
export declare function createTableWastelandWantedBoard(): string;
