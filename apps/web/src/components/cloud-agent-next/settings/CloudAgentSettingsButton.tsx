'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { CloudAgentSettingsDialog } from './CloudAgentSettingsDialog';

/**
 * Topbar button that opens the Cloud Agent settings dialog.
 *
 * Deep links:
 * - Organization scope: `/organizations/<id>/cloud?settings=compute` opens Compute.
 * - Personal scope: `/cloud?settings=profiles` opens the Profiles section for the
 *   caller's personal profiles.
 */
export function CloudAgentSettingsButton({ organizationId }: { organizationId?: string }) {
  const searchParams = useSearchParams();
  const settings = searchParams.get('settings');
  const openCompute = organizationId !== undefined && settings === 'compute';
  const openProfiles = organizationId === undefined && settings === 'profiles';
  const [open, setOpen] = useState(openCompute || openProfiles);

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
        initialSection={openCompute ? 'compute' : openProfiles ? 'profiles' : 'general'}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
