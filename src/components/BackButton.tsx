import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

type BackButtonProps = {
  href: string;
  children: React.ReactNode;
  className?: string;
};

export function BackButton({ href, children, className = '' }: BackButtonProps) {
  return (
    <Link
      href={href}
      className={`text-muted-foreground hover:text-foreground inline-flex items-center gap-2 text-sm transition-colors ${className}`}
    >
      <ArrowLeft className="h-4 w-4" />
      {children}
    </Link>
  );
}
