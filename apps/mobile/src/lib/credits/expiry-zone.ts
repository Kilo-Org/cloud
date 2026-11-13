import { isolateBidiText } from '@/lib/bidi';

/**
 * The zone the catalogs write right after `{{date}}`: ASCII parentheses in most
 * languages, full-width ones in Chinese. A catalog without a zone marker keeps
 * its sentence unchanged.
 */
const ZONE_MARKER = /(\s?)(\(UTC\)|（UTC）)/;

/**
 * Keep the zone on the date's line, in its own direction. A breakable space let
 * a wrapped marker start the next line, and a right-to-left sentence then reads
 * that marker after the following sentence, detached from the date. The
 * no-break space and the isolate leave the rest of the sentence free to wrap.
 * A catalog that writes the marker with no space, such as Chinese with its
 * full-width parentheses, keeps that spacing.
 */
export function keepZoneWithDate(sentence: string): string {
  return sentence.replace(ZONE_MARKER, (_match, space: string, marker: string) => {
    const glue = space ? '\u00A0' : '';
    return `${glue}${isolateBidiText(marker)}`;
  });
}
