import { createInstance } from 'i18next';
import { describe, expect, it } from 'vitest';

import { CATALOG_LOADERS } from './catalogs';
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from './languages';

/** The category a language's own rules assign, the same rules i18next uses. */
function category(tag: SupportedLanguage, count: number): string {
  return new Intl.PluralRules(tag).select(count);
}

const i18n = createInstance();
await i18n.init({
  resources: Object.fromEntries(
    SUPPORTED_LANGUAGES.map(tag => [tag, { translation: CATALOG_LOADERS[tag]() }])
  ),
  lng: 'en',
  fallbackLng: 'en',
  compatibilityJSON: 'v4',
  interpolation: { escapeValue: false },
  initAsync: false,
  returnNull: false,
});

/** The rendered expand row, with the count and the range held as symbols. */
function row(language: SupportedLanguage, family: string, count: number) {
  return i18n.t(family, { lng: language, count, displayCount: 'N', start: 'S', end: 'E' });
}

/** A catalog template with the row's own values in place. */
function filled(template: string): string {
  return template
    .replaceAll('{{displayCount}}', 'N')
    .replaceAll('{{start}}', 'S')
    .replaceAll('{{end}}', 'E');
}

describe('counted expand rows', () => {
  /**
   * Every catalog renders the diff's expand rows. Each places the count one of
   * two ways — as an annotation the noun cannot be governed by, or before the
   * noun with a per-category form — and the placement is a fact about each
   * catalog's own grammar, recorded group by group below.
   */
  const LABELED_FAMILIES = [
    'prReview.hunkRows.expandLines',
    'prReview.hunkRows.expandMoreLines',
    'prReview.hunkRows.expandLinesOfContext',
    'prReview.hunkRows.expandAllLines',
    'prReview.discussion.moreLinesAbove',
  ] as const;
  const ALL_LINES = 'prReview.hunkRows.expandAllLines';
  const MORE_LINES = 'prReview.hunkRows.expandMoreLines';
  const MORE_ABOVE = 'prReview.discussion.moreLinesAbove';
  /** The catalogs whose plural rules inflect a noun after a numeral. */
  const LABELED_LANGUAGES = 'ar be bs cs hr lt lv pl ru sk sl sr uk'.split(
    ' '
  ) as SupportedLanguage[];

  /**
   * Each adjudicated catalog group, with the families whose row annotates the
   * count; the group's remaining families lead the noun with the numeral, the
   * way English does. A catalog annotates exactly the families whose plural
   * phrase leans on a determiner or a verb that cannot follow a singular
   * numeral — "todas as 1 linha", "Alle 1 Zeile einblenden", "… darüber stehen
   * 1 weitere Zeile." — so the count leaves the noun's government and every
   * category renders the same grammatical wording. English leads every noun
   * ("Expand all {{displayCount}} lines"), so its singular `_one` must differ
   * from the base — a flattened family renders "Expand all 1 lines". Bosnian
   * and Croatian lead four nouns ("Prikaži 20 redova", "red", "reda",
   * "redova") and annotate `expandAllLines` — "Prikaži sve redove (20)"; a
   * flattened numeral-led row would read "Prikaži 1 redova".
   *
   * The plural determiner decides the annotation for the rest. German, Dutch
   * and Swedish lead `alle`/`alla` before the noun and Danish and Norwegian
   * lead `flere` ("more"), none of which can precede a singular numeral
   * ("Alle 1 Zeile", "1 flere linje"), so those families annotate the count
   * instead of inflecting it — Danish and Norwegian in `expandMoreLines` too,
   * whose `_one` would otherwise read "Vis 1 flere linje". French and Italian
   * lead the plural adjective `supplémentaires`/`altre` before the noun, so
   * they annotate the families that carry it. The families that only place the
   * numeral before the count-governed noun stay numeral-led, because the noun
   * itself inflects: "Afficher 1 ligne", "Mostra 1 riga". Swahili annotates
   * `expandAllLines`, whose determiner `yote` ("all", noun class 4) cannot
   * take a singular numeral, and inflects the rest for the class-3 noun
   * `mstari` (plural `mistari`) — connective `wa`, adjective `mwingine`,
   * never the class-4 `ya`/`mingine` beside the singular.
   */
  const ROW_PLACEMENT_GROUPS: readonly (readonly [
    languages: readonly SupportedLanguage[],
    annotated: readonly string[],
  ])[] = [
    ['en af am fi gu he hi kn ml mr pa sq ta te ur'.split(' ') as SupportedLanguage[], []],
    ['bg bs ca el es gl hr is mk pt pt-BR ro'.split(' ') as SupportedLanguage[], [ALL_LINES]],
    ['de nl sv'.split(' ') as SupportedLanguage[], [ALL_LINES, MORE_ABOVE]],
    ['da nb'.split(' ') as SupportedLanguage[], [ALL_LINES, MORE_LINES, MORE_ABOVE]],
    ['fr it'.split(' ') as SupportedLanguage[], [ALL_LINES, MORE_ABOVE]],
    ['sw'.split(' ') as SupportedLanguage[], [ALL_LINES]],
    // Zulu inflects the row for the class-3 singular noun `umugqa` instead:
    // "umugqa omunye", "umugqa womongo", "wonke umugqa". The count sits in the
    // quantitative concord, which follows the noun's class — `ongu-` for class
    // 3 `umugqa`, `engu-` for class 4 `imigqa` — so it stays inside the row in
    // every family and none annotates it.
    ['zu'.split(' ') as SupportedLanguage[], []],
  ];

  /** The families of `language` whose row annotates the count. */
  function annotatedFamilies(language: SupportedLanguage): readonly string[] {
    for (const [languages, annotated] of ROW_PLACEMENT_GROUPS) {
      if (languages.includes(language)) {
        return annotated;
      }
    }
    return LABELED_FAMILIES;
  }

  /** Every catalog whose row placement this branch has adjudicated. */
  const ADJUDICATED_LANGUAGES = [
    ...new Set([...ROW_PLACEMENT_GROUPS.flatMap(([languages]) => languages), ...LABELED_LANGUAGES]),
  ] as readonly SupportedLanguage[];
  const CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;

  it.each(ADJUDICATED_LANGUAGES)('annotates the count in every category of %s', language => {
    for (const family of LABELED_FAMILIES) {
      if (annotatedFamilies(language).includes(family)) {
        const base = i18n.getResource(language, 'translation', family);
        expect(typeof base, `${language} ${family}`).toBe('string');
        const other = i18n.getResource(language, 'translation', `${family}_other`);
        expect(other, `${language} ${family}_other`).toBe(base);
        for (const suffix of CATEGORIES) {
          const value = i18n.getResource(language, 'translation', `${family}_${suffix}`);
          if (value !== undefined) {
            expect(value, `${language} ${family}_${suffix}`).toBe(base);
          }
        }
        // The count selects a category but never reaches the string, so the row
        // reads the same at 1, 2, 5 and 21 whatever the language's rules select.
        expect(row(language, family, 1), `${language} ${family}`).toBe(row(language, family, 21));
        expect(row(language, family, 2), `${language} ${family}`).toBe(row(language, family, 5));
      }
    }
  });

  it.each(
    ADJUDICATED_LANGUAGES.map(
      language =>
        [
          language,
          (LABELED_FAMILIES as readonly string[]).filter(
            family => !annotatedFamilies(language).includes(family)
          ),
        ] as const
    ).filter(([, families]) => families.length > 0)
  )('inflects the numeral-led rows of %s', (language, families) => {
    for (const family of families) {
      for (const count of [1, 2, 5, 21]) {
        const key = `${family}_${category(language, count)}`;
        const declared = i18n.getResource(language, 'translation', key);
        if (typeof declared !== 'string') {
          throw new TypeError(`${language} declares no ${key}`);
        }
        // i18next selects the language's own category at this count.
        expect(row(language, family, count), `${language} ${key}`).toBe(filled(declared));
      }
      // The noun's form follows the count: one flattened form would make these
      // two rows identical.
      expect(row(language, family, 1), `${language} ${family}`).not.toBe(row(language, family, 5));
    }
  });

  /**
   * The rows the review caught: the numeral-led family left a plural modifier
   * beside a singular noun, so a one-line gap rendered "Afficher 1 ligne
   * supplémentaires", "Mostra altre 1 riga" and "1 fichiers chargés sur 5".
   * Each family here inflects the whole phrase with the count, and the
   * one-line rendering is pinned so the plural modifier cannot come back.
   */
  it('inflects the singular row the review requires', async () => {
    expect(row('fr', MORE_LINES, 1)).toBe('Afficher N ligne supplémentaire (S–E)');
    expect(row('it', MORE_LINES, 1)).toBe('Mostra N riga in più (S–E)');
    await i18n.changeLanguage('fr');
    expect(
      i18n.t('prReview.hunkRows.loadedOfTotalFiles', { count: 1, loaded: '1', total: '5' })
    ).toBe('1 fichier chargé sur 5');
    expect(
      i18n.t('agentChat.attachmentPicker.onlyAddingFiles', {
        count: 1,
        accepted: '1',
        total: '3',
        max: '5',
      })
    ).toBe('Ajout de 1 fichier seulement sur 3 (maximum : 5)');
  });

  /**
   * The other half of the review: these families lead a plural determiner that
   * cannot sit before a singular numeral — "Alle 1 Zeile", "Vis alle 1 linje",
   * "Visa alla 1 rad" — so the count moved into an annotation and every
   * category reads the same wording. Pinning the one-line render keeps the
   * determiner and the numeral from meeting again, which the invariance check
   * above cannot see if a flattened family were flattened to the wrong copy.
   */
  it('annotates the singular row the review requires', () => {
    expect(row('de', ALL_LINES, 1)).toBe('Alle Zeilen einblenden (N)');
    expect(row('nl', ALL_LINES, 1)).toBe('Alle regels tonen (N)');
    expect(row('sv', ALL_LINES, 1)).toBe('Visa alla rader (N)');
    expect(row('da', ALL_LINES, 1)).toBe('Vis alle linjer (N)');
    expect(row('nb', ALL_LINES, 1)).toBe('Vis alle linjene (N)');
    // Swahili's determiner yote ("all") is noun class 4 and cannot take a
    // singular numeral, so the count moves into the annotation here too.
    expect(row('sw', ALL_LINES, 1)).toBe('Panua mistari yote (N)');
  });

  /**
   * The rows that kept a plural word beside the singular numeral. Each of
   * these languages singles a hidden line out by inflecting the verb of its
   * `_one` category — Greek "υπάρχει", Hindi "है", Basque "dago" — or the
   * adjective beside the noun (Albanian "rresht tjetër"), so a one-line gap
   * must not render `_other`'s plural word with the singular noun ("…
   * υπάρχουν 1 επιπλέον γραμμή παραπάνω."). Pinning the one-line render keeps
   * the plural word from returning, which the category shape alone cannot see.
   */
  /** The composer's row carries only the count, not a diff range. */
  function remainingRow(language: SupportedLanguage) {
    return i18n.t('agentChat.composer.charactersRemaining', { lng: language, count: 1 });
  }

  const SINGULAR_ROWS = [
    ['el', MORE_ABOVE, '… υπάρχει N επιπλέον γραμμή παραπάνω.'],
    ['am', MORE_ABOVE, '… ከላይ ተጨማሪ N መስመር አለ።'],
    ['eu', MORE_ABOVE, '… Beste N lerro dago goian.'],
    ['hi', MORE_ABOVE, '… ऊपर N और पंक्ति है।'],
    ['mr', MORE_ABOVE, '… वर आणखी N ओळ आहे.'],
    ['ne', MORE_ABOVE, '… माथि थप N पङ्क्ति छ।'],
    ['pa', MORE_ABOVE, '… ਉੱਪਰ N ਹੋਰ ਲਾਈਨ ਹੈ।'],
    ['ta', MORE_ABOVE, '… மேலே மேலும் N வரி உள்ளது.'],
    ['te', MORE_ABOVE, '… పైన మరో N పంక్తి ఉంది.'],
    ['ur', MORE_ABOVE, 'اوپر مزید N سطر ہے…'],
    ['sq', MORE_ABOVE, '… N rresht tjetër më sipër'],
    ['am', 'agentChat.composer.charactersRemaining', '1 ቁምፊ ቀርቷል'],
    ['eu', 'agentChat.composer.charactersRemaining', '1 karaktere geratzen da'],
    ['he', 'agentChat.composer.charactersRemaining', 'נותר 1 תו'],
    ['kn', 'agentChat.composer.charactersRemaining', '1 ಅಕ್ಷರ ಉಳಿದಿದೆ'],
    ['ne', 'agentChat.composer.charactersRemaining', '1 अक्षर बाँकी छ'],
    ['pa', 'agentChat.composer.charactersRemaining', '1 ਅੱਖਰ ਬਾਕੀ ਹੈ'],
    ['sq', 'agentChat.composer.charactersRemaining', 'Mbetet 1 karakter'],
    ['ta', 'agentChat.composer.charactersRemaining', '1 எழுத்து மீதமுள்ளது'],
    ['te', 'agentChat.composer.charactersRemaining', '1 అక్షరం మిగిలి ఉంది'],
    ['ur', 'agentChat.composer.charactersRemaining', '1 حرف باقی ہے'],
    // The review also caught a plural participle beside the singular noun in
    // Catalan ("Model utilitzats (1)") and a definite plural adjective beside
    // the singular noun in Latvian ("Atlikušās rakstzīme: 1"); pin the
    // singular renderings their own grammars require.
    ['ca', 'agentChat.contextUsage.modelsCount', 'Model utilitzat (N)'],
    ['lv', 'agentChat.composer.charactersRemaining', 'Atlikusī rakstzīme: 1'],
    // Swahili's singular noun mstari is noun class 3, so its connective is wa
    // and its adjective is mwingine; the class-4 ya/mingine beside the
    // singular noun cannot come back.
    ['sw', 'prReview.hunkRows.expandLinesOfContext', 'Panua mstari N wa muktadha'],
    ['sw', 'prReview.hunkRows.expandMoreLines', 'Panua mstari mwingine N (S–E)'],
    ['sw', MORE_ABOVE, '… kuna mstari mwingine N hapo juu.'],
    // Zulu's singular noun umugqa is noun class 3, so its adjective is omunye,
    // its possessive is womongo, "all" is wonke and its quantitative concord
    // is ongu-; the class-4 eminye, yomongo, yonke and engu- beside the
    // singular noun cannot come back.
    ['zu', ALL_LINES, 'Nweba wonke umugqa ongu-N'],
    ['zu', 'prReview.hunkRows.expandLines', 'Nweba umugqa ongu-N (S–E)'],
    ['zu', 'prReview.hunkRows.expandLinesOfContext', 'Nweba umugqa womongo ongu-N'],
    ['zu', MORE_LINES, 'Nweba omunye umugqa ongu-N (S–E)'],
    ['zu', MORE_ABOVE, '… omunye umugqa ongu-N ngenhla'],
    // A one-line count of the remaining rows takes the singular noun's own
    // class: class 5 ifayela takes elingu-, class 7 isihlolo esingu-, class 11
    // usuku and uhlamvu olungu- — never the plural angu-/ezingu- the review
    // caught beside the singular noun.
    ['zu', 'agentChat.toolCard.filesBadge', 'ifayela elingu-N'],
    ['zu', 'agentChat.toolCard.linesBadge', 'umugqa ongu-N'],
    ['zu', 'securityAgent.dashboard.daysOverdue', 'Kudlule umnqamulajuqu ngosuku olungu-N'],
    ['zu', 'prReview.checks.checksCount', 'isihlolo esingu-N'],
    ['zu', 'agentChat.composer.charactersRemaining', 'Kusele uhlamvu olungu-1'],
  ] as const satisfies readonly (readonly [SupportedLanguage, string, string])[];

  it.each(SINGULAR_ROWS)('inflects the singular row of %s', (language, family, expected) => {
    const rendered =
      family === 'agentChat.composer.charactersRemaining'
        ? remainingRow(language)
        : row(language, family, 1);
    expect(rendered, `${language} ${family}`).toBe(expected);
  });

  /**
   * The two Zulu rows whose `_one` form was the `_other` string outright, so a
   * count of 1 rendered the plural row: "kulayishwe amafayela angu-1
   * kwangu-5" and "Kwengezwa amafayela angu-1 kuphela…". Both count a single
   * `ifayela` (class 5), whose quantitative concord is `elingu-`.
   */
  it('inflects the singular Zulu file rows the review requires', async () => {
    await i18n.changeLanguage('zu');
    expect(
      i18n.t('prReview.hunkRows.loadedOfTotalFiles', { count: 1, loaded: '1', total: '5' })
    ).toBe('kulayishwe ifayela elingu-1 kwangu-5');
    expect(
      i18n.t('agentChat.attachmentPicker.onlyAddingFiles', {
        count: 1,
        accepted: '1',
        total: '3',
        max: '5',
      })
    ).toBe('Kwengezwa ifayela elingu-1 kuphela kwangu-3 (umkhawulo: 5)');
  });
});
