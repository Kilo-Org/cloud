'use client';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { useTRPC } from '@/lib/trpc/utils';
import { cn } from '@/lib/utils';
import { Check, ChevronDown } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';

type OrganizationSwitcherProps = {
  organizationId?: string | null;
};

export type OrganizationSwitcherOrganization = {
  organizationId: string;
  organizationName: string;
  role: string;
};

type OrganizationSwitcherViewProps = {
  organizationId?: string | null;
  organizations?: OrganizationSwitcherOrganization[];
  isPending?: boolean;
  onOrganizationSwitch: (organizationId: string | null) => void;
};

const triggerClassName =
  'h-auto min-h-12 w-full justify-between gap-2 rounded-lg border border-border bg-transparent px-3 py-1.5 text-left hover:border-border-strong hover:bg-sidebar-accent hover:text-sidebar-accent-foreground';

const menuItemClassName =
  'flex min-h-12 cursor-pointer items-center rounded-md border border-transparent px-3 py-1.5 hover:border-border hover:bg-accent hover:text-accent-foreground';

const selectedMenuItemClassName = 'border-border bg-surface-selected text-foreground';

const switcherTextClassName = 'flex min-w-0 flex-1 flex-col items-start gap-0.5';
const switcherRowClassName = 'flex w-full min-w-0 items-center justify-between gap-2';
const switcherTitleClassName =
  'text-foreground max-w-full truncate text-sm leading-4 font-semibold';
const switcherSubtitleClassName = 'text-muted-foreground max-w-full truncate text-xs leading-4';
const switcherIconClassName = 'text-muted-foreground h-4 w-4 shrink-0';
const selectedIconClassName = 'text-primary h-4 w-4 shrink-0';

export default function OrganizationSwitcher({ organizationId = null }: OrganizationSwitcherProps) {
  const trpc = useTRPC();
  const router = useRouter();

  // Fetch user organizations
  const { data: organizations, isPending } = useQuery(
    trpc.organizations.list.queryOptions(undefined, {
      trpc: {
        context: {
          skipBatch: true,
        },
      },
    })
  );

  const handleOrganizationSwitch = (orgId: string | null) => {
    if (orgId) {
      router.push(`/organizations/${orgId}`);
    } else {
      router.push('/profile');
    }
  };

  return (
    <OrganizationSwitcherView
      organizationId={organizationId}
      organizations={organizations}
      isPending={isPending}
      onOrganizationSwitch={handleOrganizationSwitch}
    />
  );
}

export function OrganizationSwitcherView({
  organizationId = null,
  organizations = [],
  isPending = false,
  onOrganizationSwitch,
}: OrganizationSwitcherViewProps) {
  // Get role display label
  const getRoleLabel = (role: string) => {
    switch (role) {
      case 'owner':
        return 'Owner';
      case 'member':
        return 'Member';
      default:
        return 'Member';
    }
  };

  const currentOrg = organizations.find(org => org.organizationId === organizationId);
  const hasOrganizations = organizations.length > 0;

  // Show loading skeleton on initial load (before any data is available)
  if (isPending) {
    return (
      <div>
        <Button variant="ghost" disabled className={triggerClassName}>
          <div className={switcherTextClassName}>
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-16" />
          </div>
          <ChevronDown className={switcherIconClassName} />
        </Button>
      </div>
    );
  }

  // Don't render if no organizations
  if (!hasOrganizations) {
    return null;
  }

  return (
    <div>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className={triggerClassName}>
            <div className={switcherTextClassName}>
              <div className={switcherTitleClassName}>
                {currentOrg ? currentOrg.organizationName : 'Personal'}
              </div>
              <div className={switcherSubtitleClassName}>
                {currentOrg ? getRoleLabel(currentOrg.role) : 'Personal Workspace'}
              </div>
            </div>
            <ChevronDown className={switcherIconClassName} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="w-[var(--radix-dropdown-menu-trigger-width)] p-1"
          align="start"
          sideOffset={4}
        >
          {/* Organizations */}
          {organizations.map(org => (
            <DropdownMenuItem
              key={org.organizationId}
              onClick={() => onOrganizationSwitch(org.organizationId)}
              className={cn(
                menuItemClassName,
                organizationId === org.organizationId && selectedMenuItemClassName
              )}
            >
              <div className={switcherRowClassName}>
                <div className={switcherTextClassName}>
                  <div className={switcherTitleClassName}>{org.organizationName}</div>
                  <div className={switcherSubtitleClassName}>{getRoleLabel(org.role)}</div>
                </div>
                {organizationId === org.organizationId && (
                  <Check className={selectedIconClassName} />
                )}
              </div>
            </DropdownMenuItem>
          ))}

          {/* Separator */}
          <DropdownMenuSeparator />

          {/* Personal Option */}
          <DropdownMenuItem
            onClick={() => onOrganizationSwitch(null)}
            className={cn(menuItemClassName, !organizationId && selectedMenuItemClassName)}
          >
            <div className={switcherRowClassName}>
              <div className={switcherTextClassName}>
                <div className={switcherTitleClassName}>Personal</div>
                <div className={switcherSubtitleClassName}>Personal Workspace</div>
              </div>
              {!organizationId && <Check className={selectedIconClassName} />}
            </div>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
