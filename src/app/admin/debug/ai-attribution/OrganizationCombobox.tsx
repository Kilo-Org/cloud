'use client';

import { useRef, useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { ChevronsUpDown, Check, Loader2, Building2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/lib/trpc/utils';
import { useQuery } from '@tanstack/react-query';

type OrganizationComboboxProps = {
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
};

export function OrganizationCombobox({
  value,
  onValueChange,
  placeholder = 'Select organization...',
}: OrganizationComboboxProps) {
  const trpc = useTRPC();
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const { data: organizations, isLoading } = useQuery({
    ...trpc.organizations.admin.search.queryOptions({
      search: debouncedSearch,
      limit: 20,
    }),
    enabled: debouncedSearch.length >= 1,
  });

  const handleSelect = useCallback(
    (orgId: string) => {
      onValueChange(orgId);
      setOpen(false);
    },
    [onValueChange]
  );

  const selectedOrg = organizations?.find(org => org.id === value);
  const displayValue = selectedOrg?.name ?? (value || placeholder);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-mono"
          ref={triggerRef}
        >
          <span className={cn('truncate', !value && 'text-muted-foreground')}>{displayValue}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="p-0"
        align="start"
        style={{ width: triggerRef.current?.offsetWidth }}
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search by name or UUID..."
            value={searchQuery}
            onValueChange={setSearchQuery}
          />
          <CommandList className="max-h-64 overflow-auto">
            {isLoading && (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="ml-2 text-sm">Searching...</span>
              </div>
            )}
            {!isLoading && debouncedSearch.length < 1 && (
              <CommandEmpty>Type to search organizations...</CommandEmpty>
            )}
            {!isLoading && debouncedSearch.length >= 1 && organizations?.length === 0 && (
              <CommandEmpty>No organizations found</CommandEmpty>
            )}
            {!isLoading && organizations && organizations.length > 0 && (
              <CommandGroup>
                {organizations.map(org => (
                  <CommandItem
                    key={org.id}
                    value={org.id}
                    onSelect={() => handleSelect(org.id)}
                    className="flex items-center gap-2"
                  >
                    <Building2 className="text-muted-foreground size-3.5" />
                    <div className="flex flex-col">
                      <span className="truncate">{org.name}</span>
                      <span className="text-muted-foreground truncate font-mono text-xs">
                        {org.id}
                      </span>
                    </div>
                    <Check
                      className={cn(
                        'ml-auto h-4 w-4',
                        org.id === value ? 'opacity-100' : 'opacity-0'
                      )}
                    />
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
