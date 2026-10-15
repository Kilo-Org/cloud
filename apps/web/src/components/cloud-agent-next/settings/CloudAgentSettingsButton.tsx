'use client';

import { useState } from 'react';
import { Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { CloudAgentSettingsDialog } from './CloudAgentSettingsDialog';

/** Topbar button that opens the Cloud Agent settings dialog. */
export function CloudAgentSettingsButton({ organizationId }: { organizationId?: string }) {
  const [open, setOpen] = useState(false);

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
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
