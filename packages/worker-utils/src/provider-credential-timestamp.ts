import { z } from 'zod';

const isoCredentialTimestamp = z.iso.datetime({ offset: true });
const postgresTimestampPattern =
  /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2}(?::?\d{2})?)$/;

/**
 * Timestamp column of a provider credential row: an ISO datetime with offset,
 * or the Postgres text rendering of the same value
 * (`2026-04-29 01:16:12.945+00`). Postgres prints a whole-hour offset without
 * minutes, so short offsets are normalized before the ISO check; the value
 * itself is never rewritten.
 */
export const ProviderCredentialTimestampSchema = z.string().refine(value => {
  if (isoCredentialTimestamp.safeParse(value).success) return true;

  const match = postgresTimestampPattern.exec(value);
  if (!match) return false;
  const [, date, time, postgresOffset] = match;
  const offset =
    postgresOffset.length === 3
      ? `${postgresOffset}:00`
      : postgresOffset.length === 5
        ? `${postgresOffset.slice(0, 3)}:${postgresOffset.slice(3)}`
        : postgresOffset;
  return isoCredentialTimestamp.safeParse(`${date}T${time}${offset}`).success;
}, 'Invalid credential timestamp');
