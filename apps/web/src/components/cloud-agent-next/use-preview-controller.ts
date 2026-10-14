'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  gatePreviewSessionId,
  selectPreviewSessionId,
  type PreviewSessionInput,
} from './select-preview-session';
import { useOpenPreview, usePreviewUrlTemplate, type PreviewLinks } from './use-preview';

export type PreviewControllerInput = PreviewSessionInput & {
  /** Preview uses the terminal permission. */
  canOpenTerminal: boolean;
  organizationId: string | undefined;
};

export type PreviewPortDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cloudAgentSessionId: `workspace_${string}`;
  organizationId: string | undefined;
};

export type PreviewController = {
  /** The chat's preview links; null when the viewer may not open a preview. */
  links: PreviewLinks | null;
  openDialog: () => void;
  /** Props for the port dialog; null when no preview can be opened. */
  dialog: PreviewPortDialogProps | null;
};

/**
 * The chat page's preview state: the session that the preview button and the
 * chat links target, the links context value, and the port dialog.
 */
export function usePreviewController({
  canOpenTerminal,
  organizationId,
  ...sessionInput
}: PreviewControllerInput): PreviewController {
  const actionSessionId = selectPreviewSessionId(sessionInput);
  const sessionId = gatePreviewSessionId(actionSessionId, canOpenTerminal);
  const urlTemplate = usePreviewUrlTemplate(sessionId, organizationId);
  const { openPreview } = useOpenPreview(organizationId);
  const [dialogOpen, setDialogOpen] = useState(false);

  // A stale open dialog must not open against the next action session.
  useEffect(() => {
    setDialogOpen(false);
  }, [actionSessionId]);

  const openDialog = useCallback(() => {
    if (!actionSessionId) return;
    setDialogOpen(true);
  }, [actionSessionId]);

  const links = useMemo<PreviewLinks | null>(
    () =>
      sessionId !== null && urlTemplate !== null
        ? {
            urlTemplate,
            open: (port, path) => void openPreview(sessionId, port, path),
          }
        : null,
    [sessionId, urlTemplate, openPreview]
  );

  const dialog =
    links !== null && sessionId !== null
      ? {
          open: dialogOpen,
          onOpenChange: setDialogOpen,
          cloudAgentSessionId: sessionId,
          organizationId,
        }
      : null;

  return { links, openDialog, dialog };
}
