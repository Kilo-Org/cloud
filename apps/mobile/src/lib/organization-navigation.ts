import { type Href } from 'expo-router';

/**
 * The Profile tab's organization hub: the first route of the organization
 * Stack (`organization/_layout.tsx`), and the screen a route returns to when
 * it belongs to an account the reader has switched away from.
 */
export const ORGANIZATION_HUB_PATH = '/(app)/(tabs)/(3_profile)/organization' as Href;

/**
 * The name the hub registers under inside that Stack.
 *
 * Expo Router names a screen after its file below the layout that declares it,
 * and an `index.tsx` keeps the `index` segment — the same shape the profile
 * route names rely on (`profile-agent-navigation.ts`).
 */
export const ORGANIZATION_HUB_ROUTE_NAME = 'index';

/**
 * The in-app create flow. Both of its entries — the Organization section on
 * Profile and the boundary's no-organization state — read this one path, so a
 * screen that cannot pick an organization can still make one.
 */
export const CREATE_ORGANIZATION_HREF = '/(app)/(tabs)/(3_profile)/organization/create' as Href;
