import { URL } from 'url';

/**
 * Check if a URL points to a private or link-local address.
 * Rejects:
 * - 127.0.0.0/8 (localhost)
 * - 10.0.0.0/8 (private)
 * - 172.16.0.0/12 (private)
 * - 192.168.0.0/16 (private)
 * - 169.254.0.0/16 (link-local)
 * - fc00::/7 (unique local addresses - IPv6)
 * - ::1 (IPv6 loopback)
 * - IPs that resolve to internal hostnames via DNS
 *
 * @param urlString The URL to validate
 * @returns true if the URL points to a private/link-local address
 */
export function isPrivateUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    const hostname = url.hostname;

    // Check for loopback and private IP ranges
    // IPv4 private ranges: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
    // IPv4 loopback: 127.0.0.0/8
    // IPv4 link-local: 169.254.0.0/16

    if (hostname === 'localhost') return true;

    // Check IPv4 private ranges
    const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4Match) {
      const octets = ipv4Match.slice(1).map(Number);
      const [a, b, c, d] = octets;

      // Validate octets are in valid range
      if (octets.some(o => o < 0 || o > 255)) return true;

      // 127.0.0.0/8 - loopback
      if (a === 127) return true;

      // 10.0.0.0/8 - private
      if (a === 10) return true;

      // 172.16.0.0/12 - private
      if (a === 172 && b >= 16 && b <= 31) return true;

      // 192.168.0.0/16 - private
      if (a === 192 && b === 168) return true;

      // 169.254.0.0/16 - link-local
      if (a === 169 && b === 254) return true;

      // 0.0.0.0/8 - current network (reserved)
      if (a === 0) return true;
    }

    // Check IPv6 private ranges
    // fc00::/7 - unique local addresses
    // ::1 - loopback
    if (hostname.includes(':')) {
      // IPv6 loopback
      if (hostname === '::1' || hostname === '[::1]') return true;

      // IPv6 unique local addresses (fc00::/7)
      const ipv6Lower = hostname.toLowerCase().replace(/[\[\]]/g, '');
      if (ipv6Lower.startsWith('fc') || ipv6Lower.startsWith('fd')) {
        // First 7 bits are 1111110 (fc00::/7)
        return true;
      }

      // fe80::/10 - link-local
      if (ipv6Lower.startsWith('fe8') || ipv6Lower.startsWith('fe9') ||
          ipv6Lower.startsWith('fea') || ipv6Lower.startsWith('feb')) {
        return true;
      }
    }

    return false;
  } catch {
    // Invalid URL - treat as unsafe
    return true;
  }
}
