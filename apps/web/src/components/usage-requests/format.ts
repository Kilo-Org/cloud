export function formatMicrodollarsAsUsd(microdollars: string): string {
  const negative = microdollars.startsWith('-');
  const digits = (negative ? microdollars.slice(1) : microdollars).padStart(7, '0');
  const whole = digits.slice(0, -6).replace(/^0+(?=\d)/, '');
  const fraction = digits.slice(-6);
  return `${negative ? '-' : ''}$${formatMicrodollarCount(whole)}.${fraction}`;
}

export function formatMicrodollarCount(microdollars: string): string {
  return microdollars.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export const KEY_SOURCE_LABELS = {
  user_byok: 'Your key',
  kilo: 'Kilo',
  unknown: 'Not recorded',
} as const;
