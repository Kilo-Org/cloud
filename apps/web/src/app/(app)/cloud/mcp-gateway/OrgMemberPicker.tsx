'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { Check, ChevronsUpDown } from 'lucide-react';

type OrgMemberPickerProps = {
  organizationId: string;
  value: string;
  onValueChange: (userId: string) => void;
  excludeUserIds?: string[];
  disabled?: boolean;
  id?: string;
  placeholder?: string;
};

function initials(name: string, email: string) {
  const source = name.trim() || email.trim();
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

export function OrgMemberPicker({
  organizationId,
  value,
  onValueChange,
  excludeUserIds,
  disabled,
  id,
  placeholder = 'Select a member',
}: OrgMemberPickerProps) {
  const trpc = useTRPC();
  const [open, setOpen] = useState(false);
  const membersQuery = useQuery(trpc.organizations.withMembers.queryOptions({ organizationId }));

  const activeMembers = useMemo(
    () =>
      (membersQuery.data?.members ?? []).flatMap(member =>
        member.status === 'active'
          ? [{ id: member.id, name: member.name, email: member.email }]
          : []
      ),
    [membersQuery.data]
  );
  const members = useMemo(() => {
    const excluded = new Set(excludeUserIds ?? []);
    return activeMembers.filter(member => !excluded.has(member.id));
  }, [activeMembers, excludeUserIds]);

  const selected = activeMembers.find(member => member.id === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between font-normal sm:max-w-xs"
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected ? selected.name || selected.email : placeholder}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <Command
          filter={(itemValue, search) =>
            itemValue.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
          }
        >
          <CommandInput placeholder="Search members" />
          <CommandList>
            {membersQuery.isLoading && (
              <div className="text-muted-foreground p-3 text-sm">Loading members...</div>
            )}
            {membersQuery.isError && (
              <div className="text-muted-foreground p-3 text-sm">Couldn't load members.</div>
            )}
            {!membersQuery.isLoading && !membersQuery.isError && (
              <>
                <CommandEmpty>No members found.</CommandEmpty>
                <CommandGroup>
                  {members.map(member => (
                    <CommandItem
                      key={member.id}
                      value={`${member.name} ${member.email}`}
                      onSelect={() => {
                        onValueChange(member.id === value ? '' : member.id);
                        setOpen(false);
                      }}
                      className="gap-2"
                    >
                      <Avatar className="h-6 w-6">
                        <AvatarFallback className="text-[0.625rem]">
                          {initials(member.name, member.email)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate text-sm">{member.name || member.email}</span>
                        {member.name && (
                          <span className="text-muted-foreground truncate text-xs">
                            {member.email}
                          </span>
                        )}
                      </div>
                      <Check
                        className={cn(
                          'ml-auto size-4',
                          member.id === value ? 'opacity-100' : 'opacity-0'
                        )}
                      />
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
