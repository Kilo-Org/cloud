'use client';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

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
};

export function RepositoryFilter({
  repositories,
  value,
  onValueChange,
  isLoading,
}: RepositoryFilterProps) {
  return (
    <Select
      value={value || 'all'}
      onValueChange={v => onValueChange(v === 'all' ? undefined : v)}
      disabled={isLoading}
    >
      <SelectTrigger className="w-[200px]">
        <SelectValue placeholder="All Repositories" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All Repositories</SelectItem>
        {repositories.map(repo => (
          <SelectItem key={repo.id} value={repo.fullName}>
            {repo.fullName}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
