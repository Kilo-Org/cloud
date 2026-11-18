'use client';

import { useDeferredValue, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useSearchAdminOrganizations } from '@/app/admin/api/organizations/hooks';

export type SelectedSupportOrganization = { id: string; name: string };

export function SupportOrganizationPicker({
  selected,
  onSelect,
}: {
  selected: SelectedSupportOrganization | null;
  onSelect: (organization: SelectedSupportOrganization | null) => void;
}) {
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search.trim());
  const results = useSearchAdminOrganizations(deferredSearch, 10);

  if (selected) {
    return (
      <div className="flex flex-col gap-2">
        <Label>Organization</Label>
        <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{selected.name}</p>
            <p className="text-muted-foreground truncate font-mono text-xs">{selected.id}</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => onSelect(null)}>
            Change
          </Button>
        </div>
      </div>
    );
  }

  const organizations = results.data ?? [];

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="support-org-search">Organization</Label>
      <Input
        id="support-org-search"
        value={search}
        onChange={event => setSearch(event.target.value)}
        placeholder="Search by name or paste an organization ID"
        autoComplete="off"
      />
      {deferredSearch.length > 0 && (
        <div className="rounded-md border" role="listbox" aria-label="Matching organizations">
          {results.isFetching && organizations.length === 0 ? (
            <p className="text-muted-foreground px-3 py-2 text-sm" role="status">
              Searching...
            </p>
          ) : results.error ? (
            <p className="text-destructive px-3 py-2 text-sm" role="alert">
              Search failed: {results.error.message}
            </p>
          ) : organizations.length === 0 ? (
            <p className="text-muted-foreground px-3 py-2 text-sm">No matching organizations</p>
          ) : (
            organizations.map(organization => (
              <button
                key={organization.id}
                type="button"
                role="option"
                aria-selected={false}
                className="hover:bg-muted flex w-full flex-col items-start px-3 py-2 text-left"
                onClick={() => {
                  onSelect({ id: organization.id, name: organization.name });
                  setSearch('');
                }}
              >
                <span className="text-sm">{organization.name}</span>
                <span className="text-muted-foreground font-mono text-xs">{organization.id}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
