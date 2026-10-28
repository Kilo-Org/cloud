'use client';

import { Settings } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

const NONE = 'none';
const MANAGE = 'manage';

export type ProfileOption = { id: string; name: string };

type ProfileSelectProps = {
  profileId: string | null;
  savedName: string | null;
  profiles: ProfileOption[];
  labelledBy: string;
  disabled: boolean;
  onChange: (profileId: string | null) => void;
  onManage: () => void;
};

export function ProfileSelect({
  profileId,
  savedName,
  profiles,
  labelledBy,
  disabled,
  onChange,
  onManage,
}: ProfileSelectProps) {
  const listed = profiles.find(profile => profile.id === profileId);
  const name = profileId ? (listed?.name ?? savedName ?? 'Unavailable profile') : null;

  return (
    <Select
      value={profileId ?? NONE}
      onValueChange={next => {
        if (next === MANAGE) {
          onManage();
          return;
        }
        onChange(next === NONE ? null : next);
      }}
      disabled={disabled}
    >
      <SelectTrigger className="w-full pointer-coarse:min-h-11" aria-labelledby={labelledBy}>
        <SelectValue className="min-w-0">
          <span className={cn('truncate', !name && 'text-muted-foreground')}>
            {name ?? 'Default'}
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>Default</SelectItem>
        {profileId && !listed && name && <SelectItem value={profileId}>{name}</SelectItem>}
        {profiles.map(profile => (
          <SelectItem key={profile.id} value={profile.id}>
            {profile.name}
          </SelectItem>
        ))}
        <SelectSeparator />
        <SelectItem value={MANAGE}>
          <Settings className="size-4" />
          Manage profiles...
        </SelectItem>
      </SelectContent>
    </Select>
  );
}
