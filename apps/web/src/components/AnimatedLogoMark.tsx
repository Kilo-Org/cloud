import Image from 'next/image';
import { cn } from '@/lib/utils';

type AnimatedLogoMarkProps = {
  size?: number;
  className?: string;
};

/**
 * Just the Kilo mark, without the "Kilo" wordmark.
 * Use when the wordmark would duplicate adjacent text (e.g., a page title).
 *
 * Static, non-interactive — no link, no animation.
 */
export function AnimatedLogoMark({ size = 48, className }: AnimatedLogoMarkProps) {
  return (
    <span className={cn('inline-flex items-center', className)} aria-label="Kilo Code">
      {/* `kilo-v1.svg` ships with a dark `#231f20` fill; invert it for dark surfaces. */}
      <Image
        src="/kilo-v1.svg"
        alt=""
        width={size}
        height={size}
        priority
        className="invert"
        aria-hidden
      />
    </span>
  );
}
