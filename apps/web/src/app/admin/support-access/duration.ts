export type SupportDurationActionClass = 'support_read' | 'support_write';

const MAX_MINUTES: Record<SupportDurationActionClass, number> = {
  support_read: 60,
  support_write: 15,
};

export function maxSupportDurationMinutes(actionClass: SupportDurationActionClass): number {
  return MAX_MINUTES[actionClass];
}

export type ParsedSupportDuration =
  | { valid: true; minutes: number | undefined }
  | { valid: false; error: string };

export function parseSupportDurationMinutes(
  raw: string,
  actionClass: SupportDurationActionClass
): ParsedSupportDuration {
  const trimmed = raw.trim();
  if (trimmed === '') return { valid: true, minutes: undefined };

  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { valid: false, error: 'Enter a whole number of minutes greater than 0' };
  }
  return { valid: true, minutes: Math.min(parsed, MAX_MINUTES[actionClass]) };
}
