/**
 * Reads the `rel="last"` page number from a GitHub `Link` response header, or 1
 * when the response carries no link, which means the list fits on one page.
 */
export function lastLinkedPage(linkHeader: string | undefined): number {
  if (!linkHeader) return 1;

  for (const segment of linkHeader.split(',')) {
    if (!segment.includes('rel="last"')) continue;
    const page = segment.match(/[?&]page=(\d+)/);
    if (page) return Number(page[1]);
  }

  return 1;
}
