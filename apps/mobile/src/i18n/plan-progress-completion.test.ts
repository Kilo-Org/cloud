import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';

/**
 * The briefing plan row passes `count: plan.total` to `agentBriefing.metadataPlan`
 * while `{{displayDone}}` carries the finished-step number, so a plural category
 * form sees a done count of one inside a multi-step plan. A form that inflects a
 * noun, adjective or verb for that number then reads a plural predicate after the
 * numeral one.
 *
 * Each catalog below moved its completed clause to a form with no number
 * agreement — the catalog's invariant completion word, or a verbless nominal
 * phrase — so the row reads correctly at every done count. The test pins the
 * whole value at the three states a reader meets: one finished step of a
 * multi-step plan, a finished plan, and a single-step plan.
 */

interface LocaleCase {
  readonly tag: string;
  readonly render: (done: string, total: string) => string;
  /** A plan with a single step names that step in the singular in some locales. */
  readonly renderOne?: (done: string, total: string) => string;
}

const locales: readonly LocaleCase[] = [
  { tag: 'te', render: (done, total) => `ప్లాన్: ${total} దశల్లో ${done} పూర్తి` },
  { tag: 'hi', render: (done, total) => `प्लान: ${total} में से ${done} पूर्ण` },
  { tag: 'pa', render: (done, total) => `ਯੋਜਨਾ: ${total} ਵਿੱਚੋਂ ${done} ਮੁਕੰਮਲ` },
  { tag: 'gu', render: (done, total) => `પ્લાન: ${total}માંથી ${done} પૂર્ણ` },
  { tag: 'mr', render: (done, total) => `योजना: ${total} पैकी ${done} पूर्ण` },
  { tag: 'ne', render: (done, total) => `योजना: ${total} मध्ये ${done} सम्पन्न` },
  { tag: 'ur', render: (done, total) => `منصوبہ: ${total} میں سے ${done} مکمل` },
  {
    tag: 'am',
    render: (done, total) => `እቅድ: ከ${total} ደረጃዎች ውስጥ ${done} ተጠናቋል`,
    renderOne: (done, total) => `እቅድ: ከ${total} ደረጃ ውስጥ ${done} ተጠናቋል`,
  },
  { tag: 'ckb', render: (done, total) => `پلان: ${done} لە ${total} هەنگاو تەواوکراو` },
  {
    tag: 'he',
    render: (done, total) => `תוכנית: השלמת ${done} מתוך ${total} שלבים`,
    renderOne: (done, total) => `תוכנית: השלמת ${done} מתוך ${total} שלב`,
  },
  {
    tag: 'om',
    render: (done, total) => `Karoora: tarkaanfiiwwan ${total} keessaa ${done} xumurame`,
    renderOne: (done, total) => `Karoora: tarkaanfii ${total} keessaa ${done} xumurame`,
  },
  { tag: 'sw', render: (done, total) => `Mpango: hatua ${done} kati ya ${total} imekamilika` },
  { tag: 'cy', render: (done, total) => `Cynllun: ${done} o ${total} cam wedi cwblhau` },
];

const previous = i18n.language;

afterAll(async () => {
  await i18n.changeLanguage(previous);
});

describe.each(locales)('$tag briefing plan progress', ({ tag, render, renderOne }) => {
  beforeAll(async () => {
    await i18n.changeLanguage(tag);
  });

  const plan = (count: number, done: number, total: number) =>
    i18n.t('agentBriefing.metadataPlan', {
      count,
      displayDone: formatNumber(done, tag),
      displayTotal: formatNumber(total, tag),
    });

  it('states a single finished step of a multi-step plan neutrally', () => {
    expect(plan(3, 1, 3)).toBe(render(formatNumber(1, tag), formatNumber(3, tag)));
  });

  it('states a finished plan neutrally', () => {
    expect(plan(3, 3, 3)).toBe(render(formatNumber(3, tag), formatNumber(3, tag)));
  });

  it('states a single-step plan neutrally', () => {
    const single = renderOne ?? render;
    expect(plan(1, 1, 1)).toBe(single(formatNumber(1, tag), formatNumber(1, tag)));
  });
});
