import { type Href } from 'expo-router';

const CLOUD_PATH = '/(app)/agent-chat/new/cloud' as const;
const LOCAL_PATH = '/(app)/agent-chat/new/local' as const;

/**
 * Source paths for the new-session chooser.
 *
 * The cloud sub-route preserves the incoming `organizationId` (org-scoped
 * sessions live there); the local sub-route is always personal because local
 * runtime catalog discovery is keyed by the signed-in user only.
 */
export function buildNewSessionSourcePaths(organizationId?: string) {
  const cloud: Href = organizationId
    ? (`${CLOUD_PATH}?organizationId=${organizationId}` as Href)
    : (CLOUD_PATH as Href);
  const local: Href = LOCAL_PATH as Href;
  return { cloud, local };
}
