/**
 * JS-readable mirror of the style.css @theme token hexes needed by SVG/JS
 * (context donut strokes + track). Keep in sync with
 * entrypoints/sidepanel/style.css — enforced by design-token-drift.test.ts.
 */
export const DESIGN_TOKENS = {
  statusGray500: '#71717A',
  statusGreen500: '#22C55E',
  statusRed500: '#EF4444',
  statusYellow500: '#F0A900',
  surfaceOverlay: '#333333',
} as const;
