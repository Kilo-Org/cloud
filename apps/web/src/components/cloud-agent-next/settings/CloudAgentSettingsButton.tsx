'use client';

import { useCallback, useState } from 'react';
import { Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { CloudAgentSettingsDialog } from './CloudAgentSettingsDialog';
import { useCloudAgentSettingsDeepLink } from './useCloudAgentSettingsDeepLink';

/**
 * Topbar button that opens the Cloud Agent settings dialog.
 *
 * Deep links use the `settings` query:
 * - `/cloud?settings` or `/cloud?settings=general` opens General.
 * - `/cloud?settings=environments` opens Environments.
 * - `/cloud?settings=profiles` opens the Profiles section for the caller's
 *   personal profiles.
 * - `/organizations/<id>/cloud?settings=compute` opens Compute.
 *
 * Switching tabs updates `settings` so the URL always reflects the active
 * section, and closing the dialog removes it.
 */
export function CloudAgentSettingsButton({ organizationId }: { organizationId?: string }) {
  const {
    open: initialOpen,
    initialSection,
    setSection,
    clearSection,
  } = useCloudAgentSettingsDeepLink(organizationId);
  const [open, setOpen] = useState(initialOpen);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (!nextOpen) clearSection();
    },
    [clearSection]
  );

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground pointer-coarse:size-11"
            aria-label="Cloud Agent settings"
            onClick={() => setOpen(true)}
          >
            <Settings />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Settings</TooltipContent>
      </Tooltip>
      <CloudAgentSettingsDialog
        organizationId={organizationId}
        initialSection={initialSection}
        onSectionChange={setSection}
        open={open}
        onOpenChange={handleOpenChange}
      />
    </>
  );
}
