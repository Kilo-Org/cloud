import type { AnchorHTMLAttributes } from 'react';

/** Minimal shim for next/link — renders a plain <a> tag. */
export default function Link({
  href,
  children,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href?: string }) {
  return (
    <a href={href} {...props}>
      {children}
    </a>
  );
}
