'use client';

import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input } from '@/components/ui/input';

export function ChannelTokenInput({
  id,
  placeholder,
  value,
  onChange,
  disabled,
  className,
}: {
  id: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [show, setShow] = useState(false);

  return (
    <div className={`relative ${className ?? ''}`}>
      <Input
        id={id}
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        data-1p-ignore
        autoComplete="off"
        className="pr-9"
        style={show ? undefined : ({ WebkitTextSecurity: 'disc' } as React.CSSProperties)}
      />
      <button
        type="button"
        onClick={() => setShow(v => !v)}
        className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
        tabIndex={-1}
      >
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}
