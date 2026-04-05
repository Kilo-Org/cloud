'use client';

import { memo, useMemo, useState } from 'react';
import { Label } from '@/components/ui/label';
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
import { ChevronsUpDown, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

type TimezoneSelectorProps = {
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
};

/** Get a stable list of IANA timezones. */
function getTimezones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    // Fallback for older runtimes
    return [
      'UTC',
      'America/New_York',
      'America/Chicago',
      'America/Denver',
      'America/Los_Angeles',
      'Europe/London',
      'Europe/Paris',
      'Europe/Berlin',
      'Asia/Tokyo',
      'Asia/Shanghai',
      'Australia/Sydney',
    ];
  }
}

export const TimezoneSelector = memo(function TimezoneSelector({
  value,
  onValueChange,
  disabled,
}: TimezoneSelectorProps) {
  const [open, setOpen] = useState(false);
  const timezones = useMemo(() => getTimezones(), []);

  return (
    <div className="space-y-2">
      <Label>Timezone</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between font-mono text-sm"
            disabled={disabled}
          >
            {value || 'Select timezone...'}
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[320px] p-0" align="start">
          <Command>
            <CommandInput placeholder="Search timezones..." />
            <CommandList className="max-h-[200px]">
              <CommandEmpty>No timezone found.</CommandEmpty>
              <CommandGroup>
                {timezones.map(tz => (
                  <CommandItem
                    key={tz}
                    value={tz}
                    onSelect={() => {
                      onValueChange(tz);
                      setOpen(false);
                    }}
                    className="font-mono text-sm"
                  >
                    <Check
                      className={cn('mr-2 h-4 w-4', value === tz ? 'opacity-100' : 'opacity-0')}
                    />
                    {tz}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
});
