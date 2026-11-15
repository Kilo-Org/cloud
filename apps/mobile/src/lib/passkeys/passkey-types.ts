import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';

/** The passkey list as `user.getPasskeys` returns it; the types are derived, never copied. */
export type PasskeysResult = inferRouterOutputs<MobileRouter>['user']['getPasskeys'];
export type PasskeyRow = PasskeysResult['passkeys'][number];
