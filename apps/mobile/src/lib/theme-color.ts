/**
 * `#rrggbb` to an `rgba()` string for a gradient stop: expo-linear-gradient
 * ignores 8-digit hex on Android, so a translucent stop has to be written out.
 * An unparseable color falls back to black.
 */
export function resolveAlphaColor(hex: string, alpha: number): string {
  const raw = hex.replace('#', '');
  const r = Number.parseInt(raw.slice(0, 2), 16);
  const g = Number.parseInt(raw.slice(2, 4), 16);
  const b = Number.parseInt(raw.slice(4, 6), 16);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
    return `rgba(0, 0, 0, ${alpha})`;
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
