import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

/**
 * The transcript's nesting-depth status. `ChildSessionMessage` draws it when the
 * display depth of nested subagent sessions reaches its cap, so it is a status
 * note about a depth, not a limit on creating more sessions and not a ban. A
 * catalog that words it as "you cannot create or open more nested sessions"
 * puts a permission the app does not enforce in front of the reader.
 *
 * Each value below replaced such a wording. The key, the placeholder set and the
 * surrounding entries are unchanged; `en.json` still reads "Maximum nesting
 * depth reached." and `hi.json` already stated the depth alone. No call site
 * moves.
 */

const EXPECTED: Record<string, string> = {
  am: 'የጎጆ ከፍተኛ ጥልቀት ተደርሷል።',
  az: 'İç-içə sessiyaların maksimal dərinliyinə çatılıb.',
  bn: 'নেস্টেড সেশনের সর্বোচ্চ গভীরতায় পৌঁছেছে।',
  gu: 'નેસ્ટેડ સત્રોની મહત્તમ ઊંડાઈ આવી ગઈ છે.',
  ha: 'An kai iyakar zurfin zamanni na ciki.',
  he: 'עומק הקינון המרבי הושג.',
  ig: 'Erutela oke omimi nke nnọkọ dị n’ime.',
  ml: 'നെസ്റ്റഡ് സെഷനുകളുടെ പരമാവധി ആഴത്തിൽ എത്തി.',
  my: 'ထပ်နေသော စက်ရှင်များ၏ အမြင့်ဆုံးအဆင့်သို့ ရောက်နေပါပြီ။',
  ne: 'नेस्टेड सत्रको अधिकतम गहिराइमा पुगेको छ।',
  om: 'Daangaan gad fageenya turtii keessaa ga’ameera.',
  or: 'ନେଷ୍ଟେଡ୍ ସେସନର ସର୍ବାଧିକ ଗଭୀରତାରେ ପହଞ୍ଚିଛି।',
  pa: 'ਨੈਸਟਿਡ ਸੈਸ਼ਨਾਂ ਦੀ ਵੱਧ ਤੋਂ ਵੱਧ ਡੂੰਘਾਈ ਪੂਰੀ ਹੋ ਗਈ ਹੈ।',
  si: 'කැදැලි සැසිවල උපරිම ගැඹුරට ළඟා වී ඇත.',
  so: 'Waxaa la gaaray xadka qotada kalfadhiyada gudaha ah.',
  te: 'ఉపసెషన్‌ల గరిష్ట లోతు చేరుకుంది.',
  ur: 'نیسٹڈ سیشنز کی زیادہ سے زیادہ گہرائی تک پہنچ گئی ہے۔',
  uz: 'Ichma-ich sessiyalarning maksimal chuqurligiga yetdi.',
  yo: 'A ti dé òpin ìjinlẹ̀ ìgbà iṣẹ́ inú.',
};

const KEY = 'agentChat.childSession.maxNestingDepth';

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe('nesting-depth status copy', () => {
  it('states the depth alone in every reworded catalog', async () => {
    for (const [tag, expected] of Object.entries(EXPECTED)) {
      await i18n.changeLanguage(tag);
      expect(i18n.t(KEY), tag).toBe(expected);
    }
  });

  it('keeps the canonical English sentence', async () => {
    await i18n.changeLanguage('en');
    expect(i18n.t(KEY)).toBe('Maximum nesting depth reached.');
  });

  it('does not tell the Telugu reader that creating more subsessions is capped', async () => {
    await i18n.changeLanguage('te');
    const value = i18n.t(KEY);
    expect(value).not.toContain('సృష్టించే');
    expect(value).not.toContain('మరిన్ని');
  });
});
