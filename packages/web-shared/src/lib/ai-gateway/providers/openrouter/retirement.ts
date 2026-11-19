import { addMonths } from 'date-fns';

/**
 * The catalog fields the retirement note reads. `pricing.prompt` is the price the model picker
 * shows, which is the one the price note reads too.
 */
export type RetirementNoteModel = Readonly<{
  name: string;
  created: number;
  pricing: { prompt: string };
  expiration_date?: string | null;
}>;

/** A model priced high enough to earn the price note instead of any other name marker. */
export function isExpensiveModel(model: RetirementNoteModel): boolean {
  const promptPrice = Number.parseFloat(model.pricing.prompt);
  return Number.isFinite(promptPrice) && promptPrice >= 0.00001; // Opus 4.8 Fast price
}

/** A preferred model created within the last week. */
export function isNewModel(
  model: RetirementNoteModel,
  preferredIndex: number,
  now = Date.now()
): boolean {
  const ageDays = (now / 1_000 - model.created) / (24 * 3600);
  return preferredIndex >= 0 && ageDays >= 0 && ageDays < 7;
}

/**
 * The date a catalog entry retires, as the entry's own `yyyy-MM-dd`, or `undefined` when the note
 * does not apply.
 *
 * The guards keep the note's precedence over the other name markers, as the composed name had it:
 * an entry that already states a fact in its name (it ends with `)`) or reads as expensive or new
 * carries no date. `retires_on` therefore needs no ordering of its own on a client.
 */
export function retirementDate(
  model: RetirementNoteModel,
  preferredIndex: number,
  now: Date = new Date()
): string | undefined {
  if (!model.expiration_date) return undefined;
  if (isExpensiveModel(model)) return undefined;
  if (model.name.endsWith(')')) return undefined;
  if (isNewModel(model, preferredIndex, now.getTime())) return undefined;
  const expirationDate = new Date(model.expiration_date);
  if (!Number.isFinite(expirationDate.getTime())) return undefined;
  if (expirationDate > addMonths(now, 1)) return undefined;
  return model.expiration_date;
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
