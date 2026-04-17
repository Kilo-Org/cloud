'use client';

import { ChevronDown } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';

type Instance = {
  sandboxId: string;
  label: string;
};

type InstanceSwitcherProps = {
  instances: Instance[];
  selectedId: string | null;
  onSelect: (sandboxId: string) => void;
};

export function InstanceSwitcher({ instances, selectedId, onSelect }: InstanceSwitcherProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const selected = instances.find(i => i.sandboxId === selectedId);

  if (instances.length === 0) return null;

  return (
    <div ref={ref} className="relative px-3 py-2">
      <button
        onClick={() => setOpen(!open)}
        className="border-border bg-background flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm cursor-pointer hover:bg-muted transition-colors"
      >
        <div>
          <div className="text-muted-foreground text-[10px] uppercase">Instance</div>
          <div className="font-medium">{selected?.label ?? 'Select...'}</div>
        </div>
        <ChevronDown className="text-muted-foreground h-4 w-4" />
      </button>

      {open && (
        <div className="border-border bg-popover absolute left-3 right-3 z-10 mt-1 rounded-md border py-1 shadow-lg">
          {instances.map(inst => (
            <button
              key={inst.sandboxId}
              onClick={() => {
                onSelect(inst.sandboxId);
                setOpen(false);
              }}
              className={`w-full px-3 py-1.5 text-left text-sm hover:bg-muted cursor-pointer transition-colors ${
                inst.sandboxId === selectedId ? 'bg-accent' : ''
              }`}
            >
              {inst.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
