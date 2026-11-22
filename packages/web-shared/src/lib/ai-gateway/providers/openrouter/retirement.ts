import { addMonths } from 'date-fns';

/** The catalog fields the retirement note reads. */
export type RetirementNoteModel = Readonly<{
  name: string;
  created: number;
  expiration_date?: string | null;
}>;

/** A preferred model created within the last week. */
function isNewModel(
  model: RetirementNoteModel,
  preferredIndex: number,
  now = Date.now()
): boolean {
  const ageDays = (now / 1_000 - model.created) / (24 * 3600);
  return preferredIndex >= 0 && ageDays >= 0 && ageDays < 7;
}

/** The marker an entry's name carries, decided by `nameMarkerFor`. */
export type NameMarker = 'states-a-fact' | 'new' | 'retirement';

/**
 * Which marker a catalog entry's name carries: a name that already states a fact in parentheses
 * keeps it and carries no other marker, a preferred entry created in the last week carries
 * `(new)`, and every other entry is the one a retirement date may mark.
 */
export function nameMarkerFor(
  model: RetirementNoteModel,
  preferredIndex: number,
  nowMs: number = Date.now()
): NameMarker {
  if (model.name.endsWith(')')) return 'states-a-fact';
  if (isNewModel(model, preferredIndex, nowMs)) return 'new';
  return 'retirement';
}

/**
 * The date a catalog entry retires, as the parsed UTC day in `yyyy-MM-dd`, or `undefined` when the
 * note does not apply. Every client receives that shape, so an `expiration_date` that carries a
 * time still reaches them as its UTC day.
 *
 * Only the `retirement` branch of `nameMarkerFor` is dated; an entry whose name states a fact or
 * that reads as new carries no date, so `retires_on` needs no ordering of its own on a client.
 */
export function retirementDate(
  model: RetirementNoteModel,
  preferredIndex: number,
  now: Date = new Date()
): string | undefined {
  if (!model.expiration_date) return undefined;
  if (nameMarkerFor(model, preferredIndex, now.getTime()) !== 'retirement') return undefined;
  const expirationDate = new Date(model.expiration_date);
  if (!Number.isFinite(expirationDate.getTime())) return undefined;
  if (expirationDate > addMonths(now, 1)) return undefined;
  return expirationDate.toISOString().slice(0, 10);
}

/**
 * The English suffix the web and the extension show after a model name (`' (retires Nov 20)'`),
 * or `''` when the entry carries no retirement date. The mobile app words the same fact in its
 * own language from `retires_on`.
 */
export function retirementNoteSuffix(retiresOn: string | undefined): string {
  if (!retiresOn) return '';
  const date = new Date(retiresOn);
  if (!Number.isFinite(date.getTime())) return '';
  const suffix = date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  return ' (retires ' + suffix + ')';
}

/** A catalog entry's name with the English retirement note, as the web and the extension show it. */
export function modelNameWithRetirement(model: {
  readonly name: string;
  readonly retires_on?: string;
}): string {
  return model.name + retirementNoteSuffix(model.retires_on);
}
