import { z } from 'zod';
export declare const WastelandMemberRecord: z.ZodObject<{
    member_id: z.ZodString;
    wasteland_id: z.ZodString;
    user_id: z.ZodString;
    role: z.ZodEnum<{
        contributor: "contributor";
        maintainer: "maintainer";
        owner: "owner";
    }>;
    trust_level: z.ZodNumber;
    joined_at: z.ZodString;
}, z.core.$strip>;
export type WastelandMemberRecord = z.output<typeof WastelandMemberRecord>;
export declare const wasteland_members: import("../../util/table").TableQueryInterpolator<{
    name: "wasteland_members";
    columns: ("joined_at" | "member_id" | "role" | "trust_level" | "user_id" | "wasteland_id")[];
}>;
export declare function createTableWastelandMembers(): string;
