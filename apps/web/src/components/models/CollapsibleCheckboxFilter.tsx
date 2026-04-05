'use client';

import { useState } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';

interface CollapsibleCheckboxFilterProps {
  options: string[];
  selected: string[];
  onChange: (selected: string[]) => void;
  maxVisible?: number;
}

export function CollapsibleCheckboxFilter({
  options,
  selected,
  onChange,
  maxVisible = 5,
}: CollapsibleCheckboxFilterProps) {
  const [showAll, setShowAll] = useState(false);

  const handleToggle = (option: string) => {
    if (selected.includes(option)) {
      onChange(selected.filter(s => s !== option));
    } else {
      onChange([...selected, option]);
    }
  };

  const visibleOptions = showAll ? options : options.slice(0, maxVisible);
  const hasMore = options.length > maxVisible;

  return (
    <div className="space-y-2">
      <div className="max-h-48 space-y-2 overflow-y-auto">
        {visibleOptions.map(option => (
          <div key={option} className="flex items-center space-x-2">
            <Checkbox
              checked={selected.includes(option)}
              onCheckedChange={() => handleToggle(option)}
            />
            <label className="cursor-pointer text-sm" onClick={() => handleToggle(option)}>
              {option}
            </label>
          </div>
        ))}
      </div>
      {hasMore && (
        <button
          onClick={() => setShowAll(!showAll)}
          className="text-primary hover:text-primary/80 flex items-center gap-1 text-xs transition-colors"
        >
          {showAll ? (
            <>
              <ChevronUp className="h-3 w-3" />
              Show less
            </>
          ) : (
            <>
              <ChevronDown className="h-3 w-3" />
              Show {options.length - maxVisible} more
            </>
          )}
        </button>
      )}
    </div>
  );
}
