'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useUser } from '@/hooks/useUser';
import { useRoleTesting } from '@/contexts/RoleTestingContext';
import { useKilospeedShortcut } from './useKilospeedShortcut';
import { createActionRegistry, filterRegistry } from './action-registry';
import type { OmniboxContext, OmniboxActionGroup } from './types';
import { Shield, User, MapPin, ExternalLink, Info, Zap, Building2 } from 'lucide-react';
import type { OrganizationRole } from '@/lib/organizations/organization-types';

// Build version - using a constant for now, could be injected at build time
const BUILD_VERSION = 'dev';

/**
 * Extract organization ID from pathname
 */
function extractOrganizationId(pathname: string): string | null {
  const match = pathname.match(/\/organizations\/([^/]+)/);
  return match ? match[1] : null;
}

/**
 * AdminOmnibox Component
 *
 * A hidden admin command palette that can be opened by typing "kilospeed" or "ks".
 * Only available to Kilo admins.
 *
 * Features:
 * - Floating design with prominent admin styling
 * - Persistent info panel (user, page, admin links, build version)
 * - Declarative action system with conditional visibility
 * - Role testing commands on organization pages
 */
export function AdminOmnibox() {
  const [open, setOpen] = useState(false);
  const session = useSession();
  const { data: user } = useUser();

  const isAuthenticated = session?.status === 'authenticated';
  const isAdmin = session?.data?.isAdmin || user?.is_admin || false;

  // Only render for authenticated admins
  if (!isAuthenticated || !isAdmin) {
    return null;
  }

  return <AdminOmniboxInner open={open} setOpen={setOpen} />;
}

type AdminOmniboxInnerProps = {
  open: boolean;
  setOpen: (open: boolean) => void;
};

function AdminOmniboxInner({ open, setOpen }: AdminOmniboxInnerProps) {
  const pathname = usePathname();
  const { data: user } = useUser();
  const { setAssumedRole, assumedRole, originalRole } = useRoleTesting();

  const organizationId = extractOrganizationId(pathname);

  // Handle role change
  const handleRoleChange = useCallback(
    (role: 'KILO ADMIN' | 'owner' | 'member') => {
      setAssumedRole(role as OrganizationRole | 'KILO ADMIN');
      setOpen(false);
    },
    [setAssumedRole, setOpen]
  );

  // Build context
  const context: OmniboxContext = useMemo(
    () => ({
      pathname,
      organizationId,
      user: user
        ? {
            id: user.id,
            email: user.google_user_email,
            name: user.google_user_name,
            isAdmin: user.is_admin,
          }
        : null,
    }),
    [pathname, organizationId, user]
  );

  // Create and filter registry
  const registry = useMemo(
    () =>
      createActionRegistry({
        onRoleChange: handleRoleChange,
      }),
    [handleRoleChange]
  );

  const filteredRegistry = useMemo(() => filterRegistry(registry, context), [registry, context]);

  // Setup keyboard shortcut
  useKilospeedShortcut(() => setOpen(true));

  // Close on escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, setOpen]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="overflow-hidden border-2 border-yellow-500/50 bg-zinc-900 p-0 shadow-2xl shadow-yellow-500/20"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Admin Omnibox</DialogTitle>

        {/* Admin Header Banner */}
        <div className="flex items-center gap-2 border-b border-yellow-500/30 bg-yellow-500/10 px-4 py-3">
          <Zap className="h-5 w-5 text-yellow-400" />
          <span className="font-mono text-sm font-bold tracking-wider text-yellow-400">
            KILO ADMIN
          </span>
          <span className="ml-auto font-mono text-xs text-yellow-500/70">v{BUILD_VERSION}</span>
        </div>

        {/* Info Panel */}
        <div className="border-b border-zinc-700 bg-zinc-800/50 px-4 py-3">
          <div className="grid gap-2 text-sm">
            {/* User Info */}
            <div className="flex items-center gap-2 text-zinc-300">
              <User className="h-4 w-4 text-zinc-500" />
              <span className="text-zinc-500">Logged in as:</span>
              <span className="font-medium">{user?.google_user_email || 'Unknown'}</span>
            </div>

            {/* Current Page */}
            <div className="flex items-center gap-2 text-zinc-300">
              <MapPin className="h-4 w-4 text-zinc-500" />
              <span className="text-zinc-500">Page:</span>
              <span className="font-mono text-xs">{pathname}</span>
            </div>

            {/* Role Testing Status */}
            {organizationId && (
              <div className="flex items-center gap-2 text-zinc-300">
                <Shield className="h-4 w-4 text-zinc-500" />
                <span className="text-zinc-500">Role:</span>
                <span className="font-medium text-yellow-400">
                  {assumedRole || originalRole || 'Unknown'}
                </span>
                {assumedRole && originalRole && assumedRole !== originalRole && (
                  <span className="text-xs text-zinc-500">(actual: {originalRole})</span>
                )}
              </div>
            )}

            {/* Admin Links */}
            <div className="mt-1 flex flex-wrap gap-2">
              <Link
                href="/admin/organizations"
                className="inline-flex items-center gap-1 rounded bg-zinc-700 px-2 py-1 text-xs text-zinc-300 transition-colors hover:bg-zinc-600 hover:text-white"
                onClick={() => setOpen(false)}
              >
                <Building2 className="h-3 w-3" />
                Admin Panel
              </Link>
              {organizationId && (
                <Link
                  href={`/admin/organizations/${organizationId}`}
                  className="inline-flex items-center gap-1 rounded bg-zinc-700 px-2 py-1 text-xs text-zinc-300 transition-colors hover:bg-zinc-600 hover:text-white"
                  onClick={() => setOpen(false)}
                >
                  <ExternalLink className="h-3 w-3" />
                  Org Admin
                </Link>
              )}
            </div>
          </div>
        </div>

        {/* Command Palette */}
        <Command className="bg-transparent">
          <CommandInput
            placeholder="Type a command or search..."
            className="border-none focus:ring-0"
          />
          <CommandList className="max-h-[300px]">
            <CommandEmpty>No commands found.</CommandEmpty>

            {filteredRegistry.groups.map((group, index) => (
              <ActionGroupRenderer
                key={group.id}
                group={group}
                context={context}
                onClose={() => setOpen(false)}
                showSeparator={index > 0}
              />
            ))}
          </CommandList>
        </Command>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-zinc-700 bg-zinc-800/30 px-4 py-2 text-xs text-zinc-500">
          <div className="flex items-center gap-1">
            <Info className="h-3 w-3" />
            <span>Type &quot;kilospeed&quot; or &quot;ks&quot; to open</span>
          </div>
          <div>
            <kbd className="rounded bg-zinc-700 px-1.5 py-0.5 font-mono text-zinc-400">esc</kbd>
            <span className="ml-1">to close</span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type ActionGroupRendererProps = {
  group: OmniboxActionGroup;
  context: OmniboxContext;
  onClose: () => void;
  showSeparator: boolean;
};

function ActionGroupRenderer({ group, context, onClose, showSeparator }: ActionGroupRendererProps) {
  const handleSelect = useCallback(
    (action: OmniboxActionGroup['actions'][number]) => {
      void action.onSelect(context);
      onClose();
    },
    [context, onClose]
  );

  return (
    <>
      {showSeparator && <CommandSeparator />}
      <CommandGroup heading={group.label}>
        {group.actions.map(action => {
          const Icon = action.icon;
          return (
            <CommandItem
              key={action.id}
              value={`${group.label} ${action.label} ${action.keywords?.join(' ') || ''}`}
              onSelect={() => handleSelect(action)}
              className="cursor-pointer"
            >
              {Icon && <Icon className="mr-2 h-4 w-4 text-yellow-500" />}
              <div className="flex flex-col">
                <span>{action.label}</span>
                {action.description && (
                  <span className="text-xs text-zinc-500">{action.description}</span>
                )}
              </div>
              {action.shortcut && (
                <kbd className="ml-auto rounded bg-zinc-700 px-1.5 py-0.5 font-mono text-xs text-zinc-400">
                  {action.shortcut}
                </kbd>
              )}
            </CommandItem>
          );
        })}
      </CommandGroup>
    </>
  );
}
