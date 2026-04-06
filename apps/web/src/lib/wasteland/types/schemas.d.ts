import type { z } from 'zod';

export declare const WastelandOutput: z.ZodObject<
  {
    wasteland_id: z.ZodString;
    name: z.ZodString;
    owner_type: z.ZodEnum<{ user: 'user'; org: 'org' }>;
    owner_user_id: z.ZodNullable<z.ZodString>;
    organization_id: z.ZodNullable<z.ZodString>;
    dolthub_upstream: z.ZodNullable<z.ZodString>;
    visibility: z.ZodEnum<{ public: 'public'; private: 'private' }>;
    status: z.ZodEnum<{ active: 'active'; deleted: 'deleted' }>;
    created_at: z.ZodString;
    updated_at: z.ZodString;
  },
  z.core.$strip
>;

export declare const WastelandMemberOutput: z.ZodObject<
  {
    member_id: z.ZodString;
    user_id: z.ZodString;
    trust_level: z.ZodNumber;
    role: z.ZodEnum<{ contributor: 'contributor'; maintainer: 'maintainer'; owner: 'owner' }>;
    joined_at: z.ZodString;
  },
  z.core.$strip
>;

export declare const WastelandCredentialStatusOutput: z.ZodObject<
  {
    user_id: z.ZodString;
    dolthub_org: z.ZodString;
    rig_handle: z.ZodNullable<z.ZodString>;
    connected_at: z.ZodString;
  },
  z.core.$strip
>;

export declare const WastelandConfigOutput: z.ZodObject<
  {
    wasteland_id: z.ZodString;
    name: z.ZodString;
    owner_type: z.ZodEnum<{ user: 'user'; org: 'org' }>;
    owner_user_id: z.ZodNullable<z.ZodString>;
    organization_id: z.ZodNullable<z.ZodString>;
    dolthub_upstream: z.ZodNullable<z.ZodString>;
    visibility: z.ZodEnum<{ public: 'public'; private: 'private' }>;
    status: z.ZodEnum<{ active: 'active'; deleted: 'deleted' }>;
    created_at: z.ZodString;
    updated_at: z.ZodString;
  },
  z.core.$strip
>;

export declare const WantedItemOutput: z.ZodObject<
  {
    item_id: z.ZodString;
    title: z.ZodString;
    description: z.ZodString;
    status: z.ZodEnum<{ open: 'open'; claimed: 'claimed'; done: 'done' }>;
    priority: z.ZodEnum<{
      low: 'low';
      medium: 'medium';
      high: 'high';
      critical: 'critical';
    }>;
    type: z.ZodEnum<{ feature: 'feature'; bug: 'bug'; docs: 'docs'; other: 'other' }>;
    claimed_by: z.ZodNullable<z.ZodString>;
    evidence: z.ZodNullable<z.ZodString>;
    created_at: z.ZodString;
    updated_at: z.ZodString;
  },
  z.core.$strip
>;

export declare const RpcWastelandOutput: z.ZodPipe<z.ZodAny, typeof WastelandOutput>;
export declare const RpcWastelandMemberOutput: z.ZodPipe<z.ZodAny, typeof WastelandMemberOutput>;
export declare const RpcWastelandCredentialStatusOutput: z.ZodPipe<
  z.ZodAny,
  typeof WastelandCredentialStatusOutput
>;
export declare const RpcWastelandConfigOutput: z.ZodPipe<z.ZodAny, typeof WastelandConfigOutput>;
export declare const RpcWantedItemOutput: z.ZodPipe<z.ZodAny, typeof WantedItemOutput>;
