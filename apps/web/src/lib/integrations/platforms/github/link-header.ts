/**
 * Reads the `rel="last"` page number from a GitHub `Link` response header, or
 * null when the header names no last page. GitHub sends `rel="last"` for every
 * collection that spans more than one page, so a caller that also sees a
 * `rel="next"` link without a last page must not treat the response as single.
 */
export function lastLinkedPage(linkHeader: string | undefined): number | null {
  if (!linkHeader) return null;

  for (const segment of linkHeader.split(',')) {
    if (!segment.includes('rel="last"')) continue;
    const page = segment.match(/[?&]page=(\d+)/);
    if (page) return Number(page[1]);
  }

  return null;
}
