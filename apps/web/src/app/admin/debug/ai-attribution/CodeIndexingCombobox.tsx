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
import { ChevronsUpDown, Check, Loader2, FolderCode, FileCode, GitBranch } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/lib/trpc/utils';
import { useQuery } from '@tanstack/react-query';

type ProjectComboboxProps = {
  organizationId: string;
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
};

export function ProjectCombobox({
  organizationId,
  value,
  onValueChange,
  placeholder = 'Select project...',
  disabled = false,
}: ProjectComboboxProps) {
  const trpc = useTRPC();
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const { data: projects, isLoading } = useQuery({
    ...trpc.admin.aiAttribution.searchProjects.queryOptions({
      organization_id: organizationId,
      search: debouncedSearch,
      limit: 20,
    }),
    enabled: !!organizationId,
  });

  const handleSelect = useCallback(
    (projectId: string) => {
      onValueChange(projectId);
      setOpen(false);
    },
    [onValueChange]
  );

  const displayValue = value || placeholder;

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
          disabled={disabled || !organizationId}
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
            placeholder="Search projects..."
            value={searchQuery}
            onValueChange={setSearchQuery}
          />
          <CommandList className="max-h-64 overflow-auto">
            {isLoading && (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="ml-2 text-sm">Loading...</span>
              </div>
            )}
            {!isLoading && projects?.length === 0 && <CommandEmpty>No projects found</CommandEmpty>}
            {!isLoading && projects && projects.length > 0 && (
              <CommandGroup>
                {projects.map(projectId => (
                  <CommandItem
                    key={projectId}
                    value={projectId}
                    onSelect={() => handleSelect(projectId)}
                    className="flex items-center gap-2"
                  >
                    <FolderCode className="text-muted-foreground size-3.5" />
                    <span className="truncate font-mono">{projectId}</span>
                    <Check
                      className={cn(
                        'ml-auto h-4 w-4',
                        projectId === value ? 'opacity-100' : 'opacity-0'
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

type FilePathComboboxProps = {
  organizationId: string;
  projectId: string;
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
};

export function FilePathCombobox({
  organizationId,
  projectId,
  value,
  onValueChange,
  placeholder = 'Select file path...',
  disabled = false,
}: FilePathComboboxProps) {
  const trpc = useTRPC();
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const { data: filePaths, isLoading } = useQuery({
    ...trpc.admin.aiAttribution.searchFilePaths.queryOptions({
      organization_id: organizationId,
      project_id: projectId,
      search: debouncedSearch,
      limit: 20,
    }),
    enabled: !!organizationId && !!projectId,
  });

  const handleSelect = useCallback(
    (filePath: string) => {
      onValueChange(filePath);
      setOpen(false);
    },
    [onValueChange]
  );

  const displayValue = value || placeholder;

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
          disabled={disabled || !organizationId || !projectId}
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
            placeholder="Search file paths..."
            value={searchQuery}
            onValueChange={setSearchQuery}
          />
          <CommandList className="max-h-64 overflow-auto">
            {isLoading && (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="ml-2 text-sm">Loading...</span>
              </div>
            )}
            {!isLoading && filePaths?.length === 0 && (
              <CommandEmpty>No file paths found</CommandEmpty>
            )}
            {!isLoading && filePaths && filePaths.length > 0 && (
              <CommandGroup>
                {filePaths.map(filePath => (
                  <CommandItem
                    key={filePath}
                    value={filePath}
                    onSelect={() => handleSelect(filePath)}
                    className="flex items-center gap-2"
                  >
                    <FileCode className="text-muted-foreground size-3.5" />
                    <span className="truncate font-mono text-sm">{filePath}</span>
                    <Check
                      className={cn(
                        'ml-auto h-4 w-4',
                        filePath === value ? 'opacity-100' : 'opacity-0'
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

type BranchComboboxProps = {
  organizationId: string;
  projectId: string;
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
};

export function BranchCombobox({
  organizationId,
  projectId,
  value,
  onValueChange,
  placeholder = 'Select branch (optional)...',
  disabled = false,
}: BranchComboboxProps) {
  const trpc = useTRPC();
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const { data: branches, isLoading } = useQuery({
    ...trpc.admin.aiAttribution.searchBranches.queryOptions({
      organization_id: organizationId,
      project_id: projectId,
      search: debouncedSearch,
      limit: 20,
    }),
    enabled: !!organizationId && !!projectId,
  });

  const handleSelect = useCallback(
    (branch: string) => {
      onValueChange(branch);
      setOpen(false);
    },
    [onValueChange]
  );

  const displayValue = value || placeholder;

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
          disabled={disabled || !organizationId || !projectId}
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
            placeholder="Search branches..."
            value={searchQuery}
            onValueChange={setSearchQuery}
          />
          <CommandList className="max-h-64 overflow-auto">
            {isLoading && (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="ml-2 text-sm">Loading...</span>
              </div>
            )}
            {!isLoading && branches?.length === 0 && <CommandEmpty>No branches found</CommandEmpty>}
            {!isLoading && branches && branches.length > 0 && (
              <CommandGroup>
                {branches.map(branch => (
                  <CommandItem
                    key={branch}
                    value={branch}
                    onSelect={() => handleSelect(branch)}
                    className="flex items-center gap-2"
                  >
                    <GitBranch className="text-muted-foreground size-3.5" />
                    <span className="truncate font-mono">{branch}</span>
                    <Check
                      className={cn(
                        'ml-auto h-4 w-4',
                        branch === value ? 'opacity-100' : 'opacity-0'
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
