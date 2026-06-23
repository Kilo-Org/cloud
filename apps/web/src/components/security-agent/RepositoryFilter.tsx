'use client';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

type Repository = {
  id: number;
  fullName: string;
  name: string;
  private: boolean;
};

type RepositoryFilterProps = {
  repositories: Repository[];
  value: string | undefined;
  onValueChange: (value: string | undefined) => void;
  isLoading?: boolean;
  id?: string;
  className?: string;
};

export function RepositoryFilter({
  repositories,
  value,
  onValueChange,
  isLoading,
  id,
  className,
}: RepositoryFilterProps) {
  return (
    <Select
      value={value || 'all'}
      onValueChange={v => onValueChange(v === 'all' ? undefined : v)}
      disabled={isLoading}
    >
      <SelectTrigger
        id={id}
        className={cn('w-full sm:w-52', className)}
        aria-label={id ? undefined : 'Filter by repository'}
      >
        <SelectValue placeholder="All repositories" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All repositories</SelectItem>
        {repositories.map(repo => (
          <SelectItem key={repo.id} value={repo.fullName}>
            {repo.fullName}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
