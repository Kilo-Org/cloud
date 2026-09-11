import type { KiloAuthVariables } from '@kilocode/worker-utils/kilo-auth-middleware';
import type { KiloTokenPayload } from '@kilocode/worker-utils/kilo-token';

export type JwtOrgMembership = NonNullable<KiloTokenPayload['orgMemberships']>[number];

export type AuthVariables = KiloAuthVariables & {
  kiloUserId: string;
  kiloIsAdmin: boolean;
  kiloApiTokenPepper: string | null;
  kiloGastownAccess: boolean;
  kiloOrgMemberships: JwtOrgMembership[];
  requestStartTime: number;
};
