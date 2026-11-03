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

/**
 * `wrap` swaps the nowrap base class out rather than adding `whitespace-normal`
 * beside it: both utilities target the same property, so the winner would be
 * decided by stylesheet order, where `whitespace-nowrap` wins.
 */
export function TableCell({
  children,
  align = 'left',
  numeric = false,
  wrap = false,
  className = '',
}: Readonly<{
  children: React.ReactNode;
  align?: 'left' | 'right';
  numeric?: boolean;
  wrap?: boolean;
  className?: string;
}>) {
  return (
    <td
      className={`type-body px-4 py-3 sm:px-6 ${wrap ? 'whitespace-normal' : 'whitespace-nowrap'} ${align === 'right' ? 'text-right' : ''} ${numeric ? 'tabular-nums' : ''} ${className}`}
    >
      {children}
    </td>
  );
}
