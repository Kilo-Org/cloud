export const PALETTE = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
  '#f97316',
  '#6366f1',
  '#84cc16',
] as const;

export const OTHER_COLOR = '#6b7280';

export const colorForIndex = (i: number): string => PALETTE[i % PALETTE.length];
