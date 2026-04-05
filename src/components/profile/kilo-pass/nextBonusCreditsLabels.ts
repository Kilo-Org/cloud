import { KiloPassCadence } from '@/lib/kilo-pass/enums';

export function formatIsoDateLabel(params: {
  iso: string | null | undefined;
  locale?: string;
  timeZone?: string;
}): string | null {
  const { iso, locale, timeZone } = params;
  if (!iso) return null;

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  return date.toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...(timeZone ? { timeZone } : {}),
  });
}

export function getNextBonusCreditsDateInlineLabel(params: {
  cadence: KiloPassCadence;
  nextBonusCreditsAt: string | null | undefined;
  locale?: string;
  timeZone?: string;
}): string | null {
  const { cadence, nextBonusCreditsAt, locale, timeZone } = params;
  if (cadence !== KiloPassCadence.Yearly) return null;

  const dateLabel = formatIsoDateLabel({ iso: nextBonusCreditsAt, locale, timeZone });
  if (!dateLabel) return null;

  return `on ${dateLabel}`;
}
