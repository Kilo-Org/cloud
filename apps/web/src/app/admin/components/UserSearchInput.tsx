'use client';

import { useState, useEffect, useCallback } from 'react';
import { Input } from '@/components/ui/input';
import { Search, X, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface UserSearchInputProps {
  value: string;
  onChange: (value: string) => void;
  isLoading?: boolean;
  placeholder?: string;
}

export function UserSearchInput({
  value,
  onChange,
  isLoading = false,
  placeholder = 'Search by email...',
}: UserSearchInputProps) {
  const [localValue, setLocalValue] = useState(value);

  // Update local value when prop value changes
  useEffect(() => {
    setLocalValue(value);
  }, [value]);

  // Debounced onChange handler
  useEffect(() => {
    const timer = setTimeout(() => {
      if (localValue !== value) {
        onChange(localValue);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [localValue, value, onChange]);

  const handleClear = useCallback(() => {
    setLocalValue('');
    onChange('');
  }, [onChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClear();
      }
    },
    [handleClear]
  );

  return (
    <div className="relative">
      <div className="relative">
        <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
        <Input
          type="text"
          placeholder={placeholder}
          value={localValue}
          onChange={e => setLocalValue(e.target.value)}
          onKeyDown={handleKeyDown}
          className="pr-10 pl-9"
        />
        <div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-1">
          {isLoading && <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />}
          {localValue && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleClear}
              className="hover:bg-muted h-7 w-7 p-0"
              aria-label="Clear search"
            >
              <X className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
