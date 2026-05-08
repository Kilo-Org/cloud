import { z } from 'zod';
export declare const WastelandConnectedTownRecord: z.ZodObject<{
    town_id: z.ZodString;
    wasteland_id: z.ZodString;
    connected_by: z.ZodString;
    connected_at: z.ZodString;
}, z.core.$strip>;
export type WastelandConnectedTownRecord = z.output<typeof WastelandConnectedTownRecord>;
export declare const wasteland_connected_towns: import("../../util/table").TableQueryInterpolator<{
    name: "wasteland_connected_towns";
    columns: ("connected_at" | "connected_by" | "town_id" | "wasteland_id")[];
}>;
export declare function createTableWastelandConnectedTowns(): string;
