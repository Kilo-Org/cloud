/**
 * The host `URL` parses out of a fetched URL (lowercased, ASCII, with its port
 * when the URL names one), or null when the text is not a URL.
 *
 * The session card's web fetch step reads its target through this helper
 * instead of the shared derivation reading the global itself: that module
 * compiles under consumers whose `lib` has no platform globals.
 */
export function webUrlHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
