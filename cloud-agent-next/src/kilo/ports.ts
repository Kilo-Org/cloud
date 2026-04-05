// Range partially overlaps the Linux ephemeral range (32768–60999), but in an
// isolated container a 50k-port range makes collisions statistically negligible.
export const PORT_RANGE_MIN = 10000;
export const PORT_RANGE_MAX = 60000;

export function randomPort(): number {
  return PORT_RANGE_MIN + Math.floor(Math.random() * (PORT_RANGE_MAX - PORT_RANGE_MIN));
}
