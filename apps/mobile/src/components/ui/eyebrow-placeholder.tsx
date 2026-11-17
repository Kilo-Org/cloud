import { Skeleton } from '@/components/ui/skeleton';

/**
 * The bar a header's reserved eyebrow line paints while its label is still
 * loading. It is one eyebrow line tall and as wide as a short label, so the
 * reserved line stays the height the arriving text takes; the header paints it
 * over that line, which is why it never sizes the slot.
 *
 * It lives beside `Eyebrow` rather than in it: only a caller that reserves the
 * line pulls in the skeleton's shimmer, and every header that paints an
 * eyebrow from its first frame stays off that surface.
 */
export function EyebrowPlaceholder() {
  return <Skeleton className="h-2.5 w-20 rounded-full" />;
}
