'use client';

import { useCallback, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { CloudAgentSettingsDialog, type SettingsSection } from './CloudAgentSettingsDialog';

type SettingsDeepLink = {
  open: boolean;
  initialSection: SettingsSection;
};

function resolveSettingsDeepLink(
  settings: string | null,
  organizationId?: string
): SettingsDeepLink {
  if (settings === '') return { open: true, initialSection: 'general' };
  if (settings === 'general') return { open: true, initialSection: 'general' };
  if (settings === 'environments') return { open: true, initialSection: 'environments' };
  if (settings === 'profiles') return { open: true, initialSection: 'profiles' };
  if (settings === 'compute' && organizationId !== undefined)
    return { open: true, initialSection: 'compute' };
  return { open: false, initialSection: 'general' };
}

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
 * section.
 */
export function CloudAgentSettingsButton({ organizationId }: { organizationId?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { open: initialOpen, initialSection } = resolveSettingsDeepLink(
    searchParams.get('settings'),
    organizationId
  );
  const [open, setOpen] = useState(initialOpen);

  const handleSectionChange = useCallback(
    (section: SettingsSection) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set('settings', section);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams]
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
        onSectionChange={handleSectionChange}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
