'use client';

import { createContext, useCallback, useContext } from 'react';
import { skipToken, useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';

type PreviewSessionId = `workspace_${string}`;

/**
 * The session's preview URL with a `{port}` placeholder, or null when the
 * Worker does not serve preview for it. The answer changes only on a Worker
 * deploy, so it is read once per session; it is null while loading.
 */
export function usePreviewUrlTemplate(
  cloudAgentSessionId: PreviewSessionId | null,
  organizationId: string | undefined
): string | null {
  const trpc = useTRPC();
  const query = useQuery({
    ...trpc.cloudAgentNext.getPreviewOptions.queryOptions(
      cloudAgentSessionId ? { cloudAgentSessionId, organizationId } : skipToken
    ),
    staleTime: Infinity,
    retry: false,
  });
  return query.data?.enabled ? query.data.urlTemplate : null;
}

/**
 * Opens a preview tab. The tab opens before the ticket request, while the click
 * still allows a popup, and moves to the preview once the ticket arrives.
 */
export function useOpenPreview(organizationId: string | undefined) {
  const trpc = useTRPC();
  const personalCreate = useMutation(trpc.cloudAgentNext.createPreview.mutationOptions());
  const orgCreate = useMutation(trpc.organizations.cloudAgentNext.createPreview.mutationOptions());
  const createPersonal = personalCreate.mutateAsync;
  const createOrg = orgCreate.mutateAsync;

  const openPreview = useCallback(
    async (cloudAgentSessionId: PreviewSessionId, port: number, path?: string) => {
      const popup = window.open('about:blank', '_blank');
      if (!popup) {
        toast.error('Popup blocked. Allow popups for this site to open a preview.');
        return false;
      }
      popup.opener = null;

      try {
        const input = { cloudAgentSessionId, port, path };
        const result = organizationId
          ? await createOrg({ ...input, organizationId })
          : await createPersonal(input);
        popup.location.href = result.url;
        return true;
      } catch (error) {
        popup.close();
        toast.error(error instanceof Error ? error.message : 'Could not open preview.');
        return false;
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
