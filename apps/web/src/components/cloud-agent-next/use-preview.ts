'use client';

import { createContext, useCallback, useContext, useRef } from 'react';
import { skipToken, useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import type { PreviewTarget } from '../../../../../services/cloud-agent-next/src/shared/preview-target';

export function usePreviewServices(target: PreviewTarget, organizationId: string | undefined) {
  const trpc = useTRPC();
  const options = {
    staleTime: 0,
    retry: 1,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  } as const;
  const personal = useQuery({
    ...trpc.cloudAgentNext.listPreviewServices.queryOptions(organizationId ? skipToken : target),
    ...options,
  });
  const organization = useQuery({
    ...trpc.organizations.cloudAgentNext.listPreviewServices.queryOptions(
      organizationId ? { ...target, organizationId } : skipToken
    ),
    ...options,
  });
  return organizationId ? organization : personal;
}

/**
 * The target's preview URL with a `{port}` placeholder, or null when the
 * Worker does not serve preview for it. The answer changes only on a Worker
 * deploy, so it is read once per target and organization scope; it is null
 * while loading.
 */
export function usePreviewUrlTemplate(
  target: PreviewTarget | null,
  organizationId: string | undefined
): string | null {
  const trpc = useTRPC();
  const query = useQuery({
    ...trpc.cloudAgentNext.getPreviewOptions.queryOptions(
      target ? { ...target, organizationId } : skipToken
    ),
    staleTime: Infinity,
    retry: false,
  });
  return query.data?.enabled ? query.data.urlTemplate : null;
}

/**
 * Opens a preview tab. The tab opens before the ticket request, while the click
 * still allows a popup, and moves to the preview once the ticket arrives. One
 * open runs at a time, so a double click opens one tab and mints one ticket.
 */
export function useOpenPreview(organizationId: string | undefined) {
  const trpc = useTRPC();
  const personalCreate = useMutation(trpc.cloudAgentNext.createPreview.mutationOptions());
  const orgCreate = useMutation(trpc.organizations.cloudAgentNext.createPreview.mutationOptions());
  const createPersonal = personalCreate.mutateAsync;
  const createOrg = orgCreate.mutateAsync;
  // A ref, not `isPending`: the second click of a double click comes before a re-render.
  const inFlight = useRef(false);

  const openPreview = useCallback(
    async (target: PreviewTarget, port: number, path?: string) => {
      if (inFlight.current) return false;
      const popup = window.open('about:blank', '_blank');
      if (!popup) {
        toast.error('Popup blocked. Allow popups for this site to open a preview.');
        return false;
      }
      popup.opener = null;

      inFlight.current = true;
      try {
        const input = { ...target, port, path };
        const result = organizationId
          ? await createOrg({ ...input, organizationId })
          : await createPersonal(input);
        popup.location.href = result.url;
        return true;
      } catch (error) {
        popup.close();
        toast.error(error instanceof Error ? error.message : 'Could not open preview.');
        return false;
      } finally {
        inFlight.current = false;
      }
    },
    [organizationId, createOrg, createPersonal]
  );

  return { openPreview, isOpening: personalCreate.isPending || orgCreate.isPending };
}

export type PreviewLinks = {
  urlTemplate: string;
  open: (port: number, path: string) => void;
};

/** Set only where the viewer may open a preview of the session's sandbox. */
export const PreviewLinksContext = createContext<PreviewLinks | null>(null);

export function usePreviewLinks(): PreviewLinks | null {
  return useContext(PreviewLinksContext);
}
