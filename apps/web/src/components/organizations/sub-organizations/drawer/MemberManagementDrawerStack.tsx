'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { createDrawerStack } from '@/components/drawer';
import { useTRPC } from '@/lib/trpc/utils';
import { renderMemberManagementDrawerContent } from './renderMemberManagementDrawerContent';
import type { MemberManagementDrawerEntry, SubOrganizationPeopleData } from './types';

const { DrawerStackProvider: BaseProvider, useDrawerStack } =
  createDrawerStack<MemberManagementDrawerEntry>();

export { useDrawerStack as useMemberManagementDrawerStack };

/**
 * The child org's membership/invitation changes can change what the
 * parent's unified People view shows for this child, so refresh it once the
 * drawer closes.
 *
 * `createDrawerStack` has no "on close" callback — `pop`/`replace`/`closeAll`
 * just mutate `stack`, and the drawer can also close via ESC or a backdrop
 * click, which don't go through any per-feature handler at all. Watching
 * `stack.length` transition from >0 to 0 is the one hook that observes every
 * close path. That watcher needs `useDrawerStack()`, so it must live inside
 * `BaseProvider`'s context; it also needs the tRPC query client, which is a
 * page/app-level concern, not something the shared `createDrawerStack`
 * primitive should know about. Keeping it here — as a context-consuming
 * child of this feature's own provider — colocates the invalidation with the
 * feature it affects without teaching the generic primitive about tRPC, and
 * without making every page that mounts the provider re-implement it.
 */
function InvalidatePeopleOnClose({ parentOrganizationId }: { parentOrganizationId: string }) {
  const { stack } = useDrawerStack();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const wasOpenRef = useRef(false);

  useEffect(() => {
    const isOpen = stack.length > 0;
    if (!isOpen && wasOpenRef.current) {
      void queryClient.invalidateQueries(
        trpc.organizations.subOrganizations.people.queryFilter({
          organizationId: parentOrganizationId,
        })
      );
    }
    wasOpenRef.current = isOpen;
  }, [stack.length, queryClient, trpc, parentOrganizationId]);

  return null;
}

export function MemberManagementDrawerStackProvider({
  children,
  parentOrganizationId,
  people,
}: {
  children: ReactNode;
  parentOrganizationId: string;
  /**
   * The already-loaded people/children directory data, threaded down so the
   * add/remove bulk-action wizards can render from it without issuing their
   * own fetch.
   */
  people: SubOrganizationPeopleData;
}) {
  return (
    <BaseProvider
      width={760}
      renderContent={(entry, helpers) =>
        renderMemberManagementDrawerContent(parentOrganizationId, people, entry, helpers)
      }
    >
      {children}
      <InvalidatePeopleOnClose parentOrganizationId={parentOrganizationId} />
    </BaseProvider>
  );
}
