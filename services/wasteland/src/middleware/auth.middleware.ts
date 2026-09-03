import type { KiloTokenPayload } from '@kilocode/worker-utils/kilo-token';

export type JwtOrgMembership = NonNullable<KiloTokenPayload['orgMemberships']>[number];

export type AuthVariables = {
  kiloUserId: string;
  kiloIsAdmin: boolean;
  kiloApiTokenPepper: string | null;
  kiloOrgMemberships: JwtOrgMembership[];
  requestStartTime: number;
};
