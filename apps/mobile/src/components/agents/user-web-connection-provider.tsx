import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import { z } from 'zod';

import { SESSION_INGEST_WS_URL } from '@/lib/config';
import { createNativeUserWebConnectionLifecycleHooks } from '@/lib/user-web-connection-lifecycle';
import { trpcClient } from '@/lib/trpc';
import { getAuthenticatedOwner, subscribeAuthenticatedOwner } from '@/lib/context-scope';
import { LocalAccessDeniedError } from '@/lib/local-access';
import {
  assertMobileActionAdmission,
  captureMobileActionAdmission,
  createMobileUserWebConnection,
  isTransportOwner,
  type MobileUserWebConnection,
} from '@/lib/local-access-transport';
import { useOrganization } from '@/lib/organization-context';

const UserWebConnectionContext = createContext<MobileUserWebConnection | null>(null);
const commandScopeSchema = z.object({ orgId: z.string().nullish() });

type UserWebConnectionProviderProps = { children: ReactNode };

export function UserWebConnectionProvider({ children }: Readonly<UserWebConnectionProviderProps>) {
  const owner = useSyncExternalStore(subscribeAuthenticatedOwner, getAuthenticatedOwner);
  const organization = useOrganization();
  const scopeRef = useRef(organization);
  scopeRef.current = organization;
  const connection = useMemo(
    () =>
      createMobileUserWebConnection({
        owner,
        websocketUrl: `${SESSION_INGEST_WS_URL}/api/user/web`,
        getAuthToken: async () => {
          const result = await trpcClient.activeSessions.createWebTicket.mutate(undefined, {
            context: { localAccessOwner: owner },
          });
          return result.token;
        },
        captureActionAdmission: (target, boundScope) => {
          const explicit = commandScopeSchema.safeParse(target.data);
          const caller = scopeRef.current;
          const targetOrganizationId = explicit.success ? explicit.data.orgId : undefined;
          if (targetOrganizationId === undefined && !boundScope && !caller.isReady) {
            throw new LocalAccessDeniedError('context');
          }
          const callerOrganizationId = boundScope
            ? boundScope.organizationId
            : caller.organizationId;
          const organizationId =
            targetOrganizationId === undefined ? callerOrganizationId : targetOrganizationId;
          const admission = captureMobileActionAdmission(owner, organizationId);
          return () => {
            assertMobileActionAdmission(admission);
          };
        },
        lifecycleHooks: createNativeUserWebConnectionLifecycleHooks(),
      }),
    [owner]
  );

  useEffect(() => {
    // Revoke synchronously on owner publication, before React commits the replacement tree.
    const invalidate = () => {
      if (!isTransportOwner(owner)) {
        connection.destroy();
      }
    };
    const unsubscribe = subscribeAuthenticatedOwner(invalidate);
    invalidate();
    const release = owner.userId && isTransportOwner(owner) ? connection.retain() : undefined;
    return () => {
      unsubscribe();
      // StrictMode can replay this effect. Final release is reversible; owner replacement is not.
      release?.();
    };
  }, [connection, owner]);

  const ownerKey = `${owner.authEpoch}:${owner.generation}:${owner.userId ?? ''}`;
  return (
    <UserWebConnectionContext.Provider key={ownerKey} value={connection}>
      {children}
    </UserWebConnectionContext.Provider>
  );
}

export function useUserWebConnection(): MobileUserWebConnection {
  const connection = useContext(UserWebConnectionContext);
  if (!connection) {
    throw new Error('useUserWebConnection must be used within UserWebConnectionProvider');
  }
  return connection;
}
