import * as React from 'react';

export function TableHeaderCell({
  children,
  align = 'left',
}: Readonly<{ children: React.ReactNode; align?: 'left' | 'right' }>) {
  return (
    <th
      className={`type-eyebrow text-muted-foreground px-4 py-3 sm:px-6 ${align === 'right' ? 'text-right' : 'text-left'}`}
    >
      {children}
    </th>
  );
}

export function TableCell({
  children,
  align = 'left',
  numeric = false,
  className = '',
}: Readonly<{
  children: React.ReactNode;
  align?: 'left' | 'right';
  numeric?: boolean;
  className?: string;
}>) {
  return (
    <td
      className={`type-body px-4 py-3 whitespace-nowrap sm:px-6 ${align === 'right' ? 'text-right' : ''} ${numeric ? 'tabular-nums' : ''} ${className}`}
    >
      {children}
    </td>
  );
}
