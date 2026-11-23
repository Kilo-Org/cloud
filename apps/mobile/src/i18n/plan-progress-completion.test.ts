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
 * agreement — the catalog's invariant completion word, a verbless nominal phrase,
 * or counts followed by one fixed plural phrase — so the row reads correctly at
 * every done count. The test pins the whole value at each state a reader meets
 * inside a three-step plan (no step, one, two and all three finished) and on a
 * single-step plan.
 */

type LocaleCase = {
  readonly tag: string;
  readonly render: (done: string, total: string) => string;
  /** A plan with a single step names that step in the singular in some locales. */
  readonly renderOne?: (done: string, total: string) => string;
};

const locales: readonly LocaleCase[] = [
  {
    tag: 'te',
    render: (done, total) => `ప్లాన్: ${total} దశల్లో ${done} పూర్తి`,
    renderOne: (done, total) => `ప్లాన్: ${total} దశలో ${done} పూర్తి`,
  },
  { tag: 'hi', render: (done, total) => `प्लान: ${total} में से ${done} स्टेप पूर्ण` },
  { tag: 'pa', render: (done, total) => `ਯੋਜਨਾ: ${total} ਵਿੱਚੋਂ ${done} ਮੁਕੰਮਲ` },
  { tag: 'gu', render: (done, total) => `પ્લાન: ${total}માંથી ${done} પૂર્ણ` },
  { tag: 'mr', render: (done, total) => `योजना: ${total} पैकी ${done} पूर्ण` },
  { tag: 'ne', render: (done, total) => `योजना: ${total} मध्ये ${done} सम्पन्न` },
  { tag: 'ur', render: (done, total) => `منصوبہ: ${total} میں سے ${done} مکمل` },
  {
    tag: 'am',
    render: (done, total) => `እቅድ: ከ${total} ደረጃዎች ውስጥ ${done} የተጠናቀቁ`,
    renderOne: (done, total) => `እቅድ: ከ${total} ደረጃ ውስጥ ${done} የተጠናቀቀ`,
  },
  { tag: 'ckb', render: (done, total) => `پلان: ${done} لە ${total} هەنگاو تەواوکراو` },
  {
    tag: 'he',
    render: (done, total) => `תוכנית: השלמת ${done} מתוך ${total} שלבים`,
    renderOne: (done, total) => `תוכנית: השלמת ${done} מתוך ${total} שלב`,
  },
  {
    tag: 'om',
    render: (done, total) => `Karoora: ${done}/${total} tarkaanfiiwwan xumuraman`,
    renderOne: (done, total) => `Karoora: ${done}/${total} tarkaanfii xumurame`,
  },
  { tag: 'sw', render: (done, total) => `Mpango: hatua zilizokamilika ${done} kati ya ${total}` },
  { tag: 'cy', render: (done, total) => `Cynllun: ${done} o ${total} cam wedi cwblhau` },
  {
    tag: 'ha',
    render: (done, total) => `Tsari: an kammala ${done} cikin matakai ${total}`,
    renderOne: (done, total) => `Tsari: an kammala ${done} cikin mataki ${total}`,
  },
  {
    tag: 'lv',
    render: (done, total) => `Plāns: ${done}/${total} soļi pabeigti`,
    renderOne: (done, total) => `Plāns: ${done}/${total} solis pabeigts`,
  },
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

  it('states no finished step yet with the same clause', () => {
    expect(plan(3, 0, 3)).toBe(render(formatNumber(0, tag), formatNumber(3, tag)));
  });

  it('states a single finished step of a multi-step plan neutrally', () => {
    expect(plan(3, 1, 3)).toBe(render(formatNumber(1, tag), formatNumber(3, tag)));
  });

  it('states two finished steps with the same clause', () => {
    expect(plan(3, 2, 3)).toBe(render(formatNumber(2, tag), formatNumber(3, tag)));
  });

  it('states a finished plan neutrally', () => {
    expect(plan(3, 3, 3)).toBe(render(formatNumber(3, tag), formatNumber(3, tag)));
  });

  it('states a single-step plan neutrally', () => {
    const single = renderOne ?? render;
    expect(plan(1, 1, 1)).toBe(single(formatNumber(1, tag), formatNumber(1, tag)));
  });
});

/**
 * Latvian puts totals of 0, 10-19 and whole tens in the `zero` category, which
 * takes the genitive plural `soļu`. The three-step and single-step plans above
 * only reach `other` and `one`, so a plan of twelve steps pins `metadataPlan_zero`.
 */

const zeroLocales: readonly LocaleCase[] = [
  { tag: 'lv', render: (done, total) => `Plāns: ${done}/${total} soļu pabeigti` },
];

describe.each(zeroLocales)(
  '$tag briefing plan progress in the zero category',
  ({ tag, render }) => {
    beforeAll(async () => {
      await i18n.changeLanguage(tag);
    });

    const plan = (count: number, done: number, total: number) =>
      i18n.t('agentBriefing.metadataPlan', {
        count,
        displayDone: formatNumber(done, tag),
        displayTotal: formatNumber(total, tag),
      });

    it('states a partly finished plan of twelve steps in the genitive plural', () => {
      expect(plan(12, 5, 12)).toBe(render(formatNumber(5, tag), formatNumber(12, tag)));
    });
  }
);
