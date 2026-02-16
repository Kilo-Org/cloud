'use client';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useTRPC } from '@/lib/trpc/utils';
import { Check, ChevronDown } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';

type OrganizationSwitcherProps = {
  organizationId?: string | null;
};

export default function OrganizationSwitcher({ organizationId = null }: OrganizationSwitcherProps) {
  const trpc = useTRPC();
  const router = useRouter();

  // Fetch user organizations
  const { data: organizations, isLoading } = useQuery(trpc.organizations.list.queryOptions());

  const handleOrganizationSwitch = (orgId: string | null) => {
    if (orgId) {
      router.push(`/organizations/${orgId}`);
    } else {
      router.push('/profile');
    }
  };

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

  const currentOrg = organizations?.find(org => org.organizationId === organizationId);
  const hasOrganizations = organizations && organizations.length > 0;

  // Show loading skeleton while fetching
  if (isLoading) {
    return (
      <div className="mt-1">
        <div className="h-[62px] w-full animate-pulse rounded-lg border border-gray-700 bg-gray-800" />
      </div>
    );
  }

  // Don't render if no organizations
  if (!hasOrganizations) {
    return null;
  }

  return (
    <div className="mt-1">
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="h-auto w-full justify-between rounded-lg border border-gray-700 p-3 text-left hover:border-yellow-400 hover:text-yellow-300"
          >
            <div className="flex flex-col items-start">
              <div className="text-foreground text-sm font-semibold">
                {currentOrg ? currentOrg.organizationName : 'Personal'}
              </div>
              <div className="text-xs text-gray-400">
                {currentOrg ? getRoleLabel(currentOrg.role) : 'Personal Workspace'}
              </div>
            </div>
            <ChevronDown className="h-4 w-4 text-gray-500" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-64 p-1" align="start" sideOffset={4}>
          {/* Organizations */}
          {organizations.map(org => (
            <DropdownMenuItem
              key={org.organizationId}
              onClick={() => handleOrganizationSwitch(org.organizationId)}
              className={`flex cursor-pointer items-start rounded-md p-3 ${
                organizationId === org.organizationId
                  ? 'border border-yellow-400 text-yellow-300'
                  : 'border border-transparent hover:border-yellow-400 hover:text-yellow-300'
              }`}
            >
              <div className="flex w-full items-center justify-between">
                <div className="flex-1">
                  <div
                    className={`font-medium ${
                      organizationId === org.organizationId ? 'text-yellow-300' : 'text-foreground'
                    }`}
                  >
                    {org.organizationName}
                  </div>
                  <div className="mt-0.5 text-xs text-gray-400">{getRoleLabel(org.role)}</div>
                </div>
                {organizationId === org.organizationId && (
                  <Check className="ml-2 h-4 w-4 text-yellow-300" />
                )}
              </div>
            </DropdownMenuItem>
          ))}

          {/* Separator */}
          <DropdownMenuSeparator />

          {/* Personal Option */}
          <DropdownMenuItem
            onClick={() => handleOrganizationSwitch(null)}
            className={`flex cursor-pointer items-start rounded-md p-3 ${
              !organizationId
                ? 'border border-yellow-400 text-yellow-300'
                : 'border border-transparent hover:border-yellow-400 hover:text-yellow-300'
            }`}
          >
            <div className="flex w-full items-center justify-between">
              <div className="flex-1">
                <div
                  className={`font-medium ${
                    !organizationId ? 'text-yellow-300' : 'text-foreground'
                  }`}
                >
                  Personal
                </div>
                <div className="mt-0.5 text-xs text-gray-400">Personal Workspace</div>
              </div>
              {!organizationId && <Check className="ml-2 h-4 w-4 text-yellow-300" />}
            </div>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
