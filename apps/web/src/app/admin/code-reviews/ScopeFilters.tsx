'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { X, Search, User, Building2 } from 'lucide-react';
import { useSearchUsers, useSearchOrganizations } from '@/app/admin/api/code-reviews/hooks';

export type OwnershipType = 'all' | 'personal' | 'organization';

export type SelectedUser = {
  id: string;
  email: string | null;
  name: string | null;
};

export type SelectedOrg = {
  id: string;
  name: string | null;
  plan: string | null;
};

const ownershipLabels = {
  all: 'All',
  personal: 'Personal',
  organization: 'Organizations',
} satisfies Record<OwnershipType, string>;

type Props = {
  /**
   * Distinguishes this instance's DOM identifiers from every other instance on
   * the page. Radio inputs sharing a `name` become a single native group, so
   * arrow keys would otherwise move focus between sections.
   */
  instanceId: string;
  ownershipType: OwnershipType;
  onOwnershipTypeChange: (type: OwnershipType) => void;
  selectedUser: SelectedUser | null;
  onSelectUser: (user: SelectedUser) => void;
  onClearUser: () => void;
  selectedOrg: SelectedOrg | null;
  onSelectOrg: (org: SelectedOrg) => void;
  onClearOrg: () => void;
  hasActiveFilter: boolean;
  onClearFilters: () => void;
};

/**
 * Ownership / user / org scope controls, rendered once per section that
 * consumes them (current queue health and historical telemetry) so each
 * section's data is always adjacent to the filters that affect it. The
 * selection itself is owned by the parent page and shared across both renders,
 * so a change in either instance updates both. Search text and dropdown
 * visibility stay local, so typing in one instance does not open the other's
 * dropdown.
 */
export function ScopeFilters({
  instanceId,
  ownershipType,
  onOwnershipTypeChange,
  selectedUser,
  onSelectUser,
  onClearUser,
  selectedOrg,
  onSelectOrg,
  onClearOrg,
  hasActiveFilter,
  onClearFilters,
}: Props) {
  const [userSearchQuery, setUserSearchQuery] = useState('');
  const [orgSearchQuery, setOrgSearchQuery] = useState('');
  const [showUserDropdown, setShowUserDropdown] = useState(false);
  const [showOrgDropdown, setShowOrgDropdown] = useState(false);

  // Both instances issue the same query key, so React Query serves them from a
  // single cache entry rather than duplicating the request.
  const userSearchResults = useSearchUsers(userSearchQuery, showUserDropdown);
  const orgSearchResults = useSearchOrganizations(orgSearchQuery, showOrgDropdown);

  const userInputId = `${instanceId}-user-search`;
  const orgInputId = `${instanceId}-org-search`;

  const resetSearchInputs = () => {
    setUserSearchQuery('');
    setOrgSearchQuery('');
    setShowUserDropdown(false);
    setShowOrgDropdown(false);
  };

  const handleSelectUser = (user: SelectedUser) => {
    resetSearchInputs();
    onSelectUser(user);
  };

  const handleSelectOrg = (org: SelectedOrg) => {
    resetSearchInputs();
    onSelectOrg(org);
  };

  const handleClearFilters = () => {
    resetSearchInputs();
    onClearFilters();
  };

  return (
    <div className="flex flex-wrap items-start gap-4">
      {/* Ownership Type Filter */}
      <fieldset className="flex flex-wrap items-center gap-4 border-0 p-0">
        <legend className="float-left mr-4 text-sm font-medium">Ownership</legend>
        {(Object.keys(ownershipLabels) as OwnershipType[]).map(type => (
          <label
            key={type}
            className={`flex cursor-pointer items-center gap-2 text-sm ${
              (selectedUser || selectedOrg) && type !== 'all' ? 'cursor-not-allowed opacity-50' : ''
            }`}
          >
            <input
              type="radio"
              name={`${instanceId}-ownershipType`}
              value={type}
              checked={ownershipType === type && !selectedUser && !selectedOrg}
              onChange={() => {
                if (!selectedUser && !selectedOrg) {
                  onOwnershipTypeChange(type);
                }
              }}
              disabled={!!(selectedUser || selectedOrg)}
              className="h-4 w-4"
            />
            {ownershipLabels[type]}
          </label>
        ))}
      </fieldset>

      {/* User Search */}
      <div className="relative w-64">
        <label htmlFor={userInputId} className="mb-1 block text-sm font-medium">
          User
        </label>
        {selectedUser ? (
          <div className="bg-primary/10 border-primary/30 flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
            <User className="text-primary h-4 w-4" />
            <span className="flex-1 truncate">
              {selectedUser.name || selectedUser.email || selectedUser.id}
            </span>
            <button
              type="button"
              aria-label="Clear user filter"
              onClick={onClearUser}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <div className="relative">
            <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
            <Input
              id={userInputId}
              placeholder="Search users..."
              value={userSearchQuery}
              onChange={e => {
                setUserSearchQuery(e.target.value);
                setShowUserDropdown(true);
              }}
              onFocus={() => setShowUserDropdown(true)}
              onBlur={() => setTimeout(() => setShowUserDropdown(false), 200)}
              className="pl-9"
            />
            {showUserDropdown && userSearchQuery && (
              <div className="bg-popover text-popover-foreground absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-md border shadow-lg">
                {userSearchResults.isLoading ? (
                  <div className="text-muted-foreground px-3 py-2 text-sm">Searching...</div>
                ) : userSearchResults.data?.length === 0 ? (
                  <div className="text-muted-foreground px-3 py-2 text-sm">No users found</div>
                ) : (
                  userSearchResults.data?.map(user => (
                    <button
                      type="button"
                      key={user.id}
                      onClick={() => handleSelectUser(user)}
                      className="hover:bg-accent hover:text-accent-foreground flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
                    >
                      <User className="text-muted-foreground h-4 w-4" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{user.name || 'Unknown'}</div>
                        <div className="text-muted-foreground truncate text-xs">{user.email}</div>
                      </div>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Org Search */}
      <div className="relative w-64">
        <label htmlFor={orgInputId} className="mb-1 block text-sm font-medium">
          Organization
        </label>
        {selectedOrg ? (
          <div className="flex items-center gap-2 rounded-md border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-sm">
            <Building2 className="h-4 w-4 text-violet-500" />
            <span className="flex-1 truncate">{selectedOrg.name || selectedOrg.id}</span>
            {selectedOrg.plan && (
              <span className="rounded bg-violet-500/20 px-1.5 py-0.5 text-xs text-violet-400">
                {selectedOrg.plan}
              </span>
            )}
            <button
              type="button"
              aria-label="Clear organization filter"
              onClick={onClearOrg}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <div className="relative">
            <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
            <Input
              id={orgInputId}
              placeholder="Search organizations..."
              value={orgSearchQuery}
              onChange={e => {
                setOrgSearchQuery(e.target.value);
                setShowOrgDropdown(true);
              }}
              onFocus={() => setShowOrgDropdown(true)}
              onBlur={() => setTimeout(() => setShowOrgDropdown(false), 200)}
              className="pl-9"
            />
            {showOrgDropdown && orgSearchQuery && (
              <div className="bg-popover text-popover-foreground absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-md border shadow-lg">
                {orgSearchResults.isLoading ? (
                  <div className="text-muted-foreground px-3 py-2 text-sm">Searching...</div>
                ) : orgSearchResults.data?.length === 0 ? (
                  <div className="text-muted-foreground px-3 py-2 text-sm">
                    No organizations found
                  </div>
                ) : (
                  orgSearchResults.data?.map(org => (
                    <button
                      type="button"
                      key={org.id}
                      onClick={() => handleSelectOrg(org)}
                      className="hover:bg-accent hover:text-accent-foreground flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
                    >
                      <Building2 className="text-muted-foreground h-4 w-4" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{org.name || 'Unknown'}</div>
                      </div>
                      {org.plan && (
                        <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-xs">
                          {org.plan}
                        </span>
                      )}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Clear Filters Button */}
      {hasActiveFilter && (
        <div className="flex items-end">
          <Button variant="ghost" size="sm" onClick={handleClearFilters} className="h-10">
            <X className="mr-1 h-4 w-4" />
            Clear filters
          </Button>
        </div>
      )}
    </div>
  );
}
