'use client';

import { useOrganizationWithMembers } from '@/app/api/organizations/hooks';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const ALL = '__all__';

export function parseStartParam(value: string | null): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function toDateTimeLocalValue(time: number): string {
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function StartTimeFilter({
  id,
  startTime,
  rollingTime,
  error,
  onChange,
}: {
  id: string;
  startTime: string | null;
  rollingTime: number;
  error: string | null;
  onChange: (startTime: string | null) => void;
}) {
  const errorId = `${id}-error`;
  const handleChange = (value: string) => {
    const time = value ? new Date(value).getTime() : Number.NaN;
    onChange(Number.isNaN(time) || time >= Date.now() ? null : new Date(time).toISOString());
  };

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Start time</Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="datetime-local"
          value={toDateTimeLocalValue(startTime ? Date.parse(startTime) : rollingTime)}
          aria-invalid={error !== null}
          aria-describedby={error ? errorId : undefined}
          className="w-56 cursor-pointer tabular-nums [&::-webkit-calendar-picker-indicator]:cursor-pointer"
          onClick={event => event.currentTarget.showPicker?.()}
          onChange={event => handleChange(event.target.value)}
        />
        {startTime && (
          <Button variant="ghost" size="sm" onClick={() => onChange(null)}>
            Now
          </Button>
        )}
      </div>
      {error && (
        <p id={errorId} className="text-destructive text-xs">
          {error}
        </p>
      )}
    </div>
  );
}

export function UserFilter({
  id,
  organizationId,
  userId,
  onChange,
}: {
  id: string;
  organizationId: string;
  userId: string | null;
  onChange: (userId: string | null) => void;
}) {
  const membersQuery = useOrganizationWithMembers(organizationId);
  const users = (membersQuery.data?.members ?? [])
    .flatMap(member =>
      member.status === 'active' ? [{ id: member.id, label: member.name || member.email }] : []
    )
    .sort((a, b) => a.label.localeCompare(b.label));
  if (userId && !users.some(user => user.id === userId)) {
    users.push({ id: userId, label: userId });
  }

  return (
    <OptionFilter
      id={id}
      label="User"
      allLabel="All users"
      value={userId}
      options={users.map(user => ({ value: user.id, label: user.label }))}
      onChange={onChange}
    />
  );
}

export function OptionFilter<T extends string>({
  id,
  label,
  allLabel,
  value,
  options,
  onChange,
  className = 'w-56',
}: {
  id: string;
  label: string;
  allLabel: string;
  value: T | null;
  options: readonly { value: T; label: string }[];
  onChange: (value: T | null) => void;
  className?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={value ?? ALL}
        onValueChange={selected =>
          onChange(options.find(option => option.value === selected)?.value ?? null)
        }
      >
        <SelectTrigger id={id} className={className}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{allLabel}</SelectItem>
          {options.map(option => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
