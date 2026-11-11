'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PreviewTarget } from '../../../../../services/cloud-agent-next/src/shared/preview-target';
import {
  gatePreviewTarget,
  selectPreviewTarget,
  type PreviewSessionInput,
} from './select-preview-session';
import { useOpenPreview, usePreviewUrlTemplate, type PreviewLinks } from './use-preview';

export type PreviewControllerInput = PreviewSessionInput & {
  canOpenPreview: boolean;
  organizationId: string | undefined;
};

export type PreviewPortDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: PreviewTarget;
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
 * The chat page's preview state: the target that the preview button and the
 * chat links use, the links context value, and the port dialog.
 */
export function usePreviewController({
  selectedWorktreeId,
  sessionId,
  canOpenPreview,
  organizationId,
}: PreviewControllerInput): PreviewController {
  const actionTarget = useMemo(
    () => selectPreviewTarget({ selectedWorktreeId, sessionId }),
    [selectedWorktreeId, sessionId]
  );
  const target = useMemo(
    () => gatePreviewTarget(actionTarget, canOpenPreview),
    [actionTarget, canOpenPreview]
  );
  const urlTemplate = usePreviewUrlTemplate(target, organizationId);
  const { openPreview } = useOpenPreview(organizationId);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    setDialogOpen(false);
  }, [target?.worktreeId, target?.cloudAgentSessionId, organizationId]);

  const openDialog = useCallback(() => {
    if (!actionTarget) return;
    setDialogOpen(true);
  }, [actionTarget]);

  const links = useMemo<PreviewLinks | null>(
    () =>
      target !== null && urlTemplate !== null
        ? {
            urlTemplate,
            open: (port, path) => void openPreview(target, port, path),
          }
        : null,
    [target, urlTemplate, openPreview]
  );

  const dialog =
    links !== null && target !== null
      ? {
          open: dialogOpen,
          onOpenChange: setDialogOpen,
          target,
          organizationId,
        }
      : null;

  return { links, openDialog, dialog };
}
