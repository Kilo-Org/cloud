import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

/**
 * Each of these keys stated something the English copy does not:
 *
 * - `analysisState.notExploitable` made the code, or access to it, the thing
 *   that cannot be reached, so the status could be read as a repository-access
 *   or analysis failure instead of "no reachable path".
 * - `eventActions.findingSuperseded` used the plain "changed" verb, which reads
 *   as the same event as the sibling "Status changed" and "Severity changed".
 * - `commands.remediationsQueued` introduced a request entity, so the toast said
 *   requests for the remediations were queued rather than the remediations.
 * - `dashboardMetrics.reviewSlaAssignment` asked the reader to review deadlines
 *   that were already set instead of reviewing SLA assignment.
 * - `findingList.emptyTitle` and `remediationUnavailable.findingNotOpen` said
 *   "unresolved" where the English names the open status, so a catalog whose own
 *   open status label reads "open" claimed findings were resolved.
 *
 * The values below are pinned so a later edit cannot reintroduce the same
 * wording. Locales are grouped by the key they fix.
 */

const CASES: Array<{ locale: string; key: string; value: string }> = [
  // The unreachable object is the path, not the code.
  { locale: 'hi', key: 'securityAgent.analysisState.notExploitable', value: 'पहुँच योग्य पथ नहीं' },
  { locale: 'be', key: 'securityAgent.analysisState.notExploitable', value: 'Недасягальны шлях' },
  { locale: 'ru', key: 'securityAgent.analysisState.notExploitable', value: 'Недостижимый путь' },
  { locale: 'uk', key: 'securityAgent.analysisState.notExploitable', value: 'Недосяжний шлях' },
  { locale: 'bn', key: 'securityAgent.analysisState.notExploitable', value: 'প্রবেশযোগ্য কোডপথ নেই' },
  {
    locale: 'my',
    key: 'securityAgent.analysisState.notExploitable',
    value: 'ရောက်ရှိနိုင်သော လမ်းကြောင်း မရှိ',
  },
  {
    locale: 'uz',
    key: 'securityAgent.analysisState.notExploitable',
    value: "Yetib bo'lmaydigan yo'l",
  },

  // The superseded event reads as replaced, not as a generic change.
  {
    locale: 'hi',
    key: 'securityAgent.auditReport.eventActions.findingSuperseded',
    value: 'प्रतिस्थापित किया गया',
  },
  {
    locale: 'kn',
    key: 'securityAgent.auditReport.eventActions.findingSuperseded',
    value: 'ಪ್ರತಿಸ್ಥಾಪಿಸಲಾಗಿದೆ',
  },
  {
    locale: 'pa',
    key: 'securityAgent.auditReport.eventActions.findingSuperseded',
    value: 'ਪ੍ਰਤਿਸਥਾਪਿਤ ਕੀਤਾ ਗਿਆ',
  },
  {
    locale: 'ta',
    key: 'securityAgent.auditReport.eventActions.findingSuperseded',
    value: 'மாற்றீடு செய்யப்பட்டது',
  },

  // The existing remediations are the queued item.
  {
    locale: 'hi',
    key: 'securityAgent.commands.remediationsQueued',
    value: 'मौजूदा सुधार कतार में जोड़े गए।',
  },

  // Review SLA assignment, not deadlines already set.
  {
    locale: 'hi',
    key: 'securityAgent.dashboardMetrics.reviewSlaAssignment',
    value: 'SLA निर्धारण की समीक्षा करें',
  },
  {
    locale: 'am',
    key: 'securityAgent.dashboardMetrics.reviewSlaAssignment',
    value: 'የSLA ምደባን ይገምግሙ',
  },
  {
    locale: 'ar',
    key: 'securityAgent.dashboardMetrics.reviewSlaAssignment',
    value: 'مراجعة تعيين الـSLA',
  },
  {
    locale: 'be',
    key: 'securityAgent.dashboardMetrics.reviewSlaAssignment',
    value: 'Праверце прызначэнне тэрмінаў SLA',
  },
  {
    locale: 'bg',
    key: 'securityAgent.dashboardMetrics.reviewSlaAssignment',
    value: 'Прегледай задаването на срокове по SLA',
  },
  {
    locale: 'bn',
    key: 'securityAgent.dashboardMetrics.reviewSlaAssignment',
    value: 'SLA নির্ধারণ পর্যালোচনা করুন',
  },
  {
    locale: 'cy',
    key: 'securityAgent.dashboardMetrics.reviewSlaAssignment',
    value: "Adolygu aseinio'r SLA",
  },
  {
    locale: 'fa',
    key: 'securityAgent.dashboardMetrics.reviewSlaAssignment',
    value: 'بررسی تخصیص SLA',
  },
  {
    locale: 'he',
    key: 'securityAgent.dashboardMetrics.reviewSlaAssignment',
    value: 'בדיקת הקצאת ה-SLA',
  },
  {
    locale: 'mk',
    key: 'securityAgent.dashboardMetrics.reviewSlaAssignment',
    value: 'Провери доделувањето на рокови според SLA',
  },
  {
    locale: 'ml',
    key: 'securityAgent.dashboardMetrics.reviewSlaAssignment',
    value: 'SLA അനുവദന പരിശോധിക്കുക',
  },
  {
    locale: 'mn',
    key: 'securityAgent.dashboardMetrics.reviewSlaAssignment',
    value: 'SLA оноолтыг шалгах',
  },
  {
    locale: 'ne',
    key: 'securityAgent.dashboardMetrics.reviewSlaAssignment',
    value: 'SLA तोकाईको समीक्षा गर्नुहोस्',
  },
  {
    locale: 'or',
    key: 'securityAgent.dashboardMetrics.reviewSlaAssignment',
    value: 'SLA ନିର୍ଦ୍ଧାରଣ ସମୀକ୍ଷା କରନ୍ତୁ',
  },
  {
    locale: 'pl',
    key: 'securityAgent.dashboardMetrics.reviewSlaAssignment',
    value: 'Sprawdź przydział SLA',
  },
  {
    locale: 'ru',
    key: 'securityAgent.dashboardMetrics.reviewSlaAssignment',
    value: 'Проверить назначение сроков SLA',
  },
  {
    locale: 'sl',
    key: 'securityAgent.dashboardMetrics.reviewSlaAssignment',
    value: 'Preglej dodeljevanje rokov SLA',
  },
  {
    locale: 'sr',
    key: 'securityAgent.dashboardMetrics.reviewSlaAssignment',
    value: 'Proveri dodelu rokova prema SLA',
  },
  {
    locale: 'uk',
    key: 'securityAgent.dashboardMetrics.reviewSlaAssignment',
    value: 'Перевірити призначення термінів за SLA',
  },

  // The list is filtered to the open status, so the empty title names it.
  { locale: 'hi', key: 'securityAgent.findingList.emptyTitle', value: 'कोई खुली समस्या नहीं' },
  { locale: 'bn', key: 'securityAgent.findingList.emptyTitle', value: 'কোনো খোলা ত্রুটি নেই' },
  {
    locale: 'ha',
    key: 'securityAgent.findingList.emptyTitle',
    value: 'Babu matsalolin da suke buɗe',
  },
  {
    locale: 'ja',
    key: 'securityAgent.findingList.emptyTitle',
    value: 'オープンな検出結果はありません',
  },
  { locale: 'kn', key: 'securityAgent.findingList.emptyTitle', value: 'ಓಪನ್ ಸಮಸ್ಯೆಗಳಿಲ್ಲ' },
  { locale: 'ko', key: 'securityAgent.findingList.emptyTitle', value: '오픈 문제 없음' },
  { locale: 'ml', key: 'securityAgent.findingList.emptyTitle', value: 'ഓപ്പൺ കണ്ടെത്തലുകളില്ല' },
  { locale: 'mr', key: 'securityAgent.findingList.emptyTitle', value: 'उघडे निष्कर्ष नाहीत' },
  { locale: 'my', key: 'securityAgent.findingList.emptyTitle', value: 'ဖွင့်ထားသော တွေ့ရှိချက် မရှိပါ' },
  { locale: 'or', key: 'securityAgent.findingList.emptyTitle', value: 'କୌଣସି ଖୋଲା ଚିହ୍ନଟ ସମସ୍ୟା ନାହିଁ' },
  { locale: 'ta', key: 'securityAgent.findingList.emptyTitle', value: 'திறந்த சிக்கல்கள் இல்லை' },
  { locale: 'te', key: 'securityAgent.findingList.emptyTitle', value: 'ఓపెన్ సమస్యలు లేవు' },
  { locale: 'ur', key: 'securityAgent.findingList.emptyTitle', value: 'کوئی کھلا مسئلہ نہیں' },
  { locale: 'vi', key: 'securityAgent.findingList.emptyTitle', value: 'Không có vấn đề đang mở' },
  { locale: 'zh-Hant', key: 'securityAgent.findingList.emptyTitle', value: '沒有開啟的資安問題' },
  {
    locale: 'zu',
    key: 'securityAgent.findingList.emptyTitle',
    value: 'Akukho okutholakele okuvulekile',
  },

  // The reason states the open-status change, not a resolution claim.
  {
    locale: 'hi',
    key: 'securityAgent.remediationUnavailable.findingNotOpen',
    value: 'समस्या अब खुली नहीं है।',
  },
  {
    locale: 'bn',
    key: 'securityAgent.remediationUnavailable.findingNotOpen',
    value: 'ত্রুটিটি আর খোলা নেই।',
  },
  {
    locale: 'ja',
    key: 'securityAgent.remediationUnavailable.findingNotOpen',
    value: 'この検出結果はオープンではなくなりました。',
  },
  {
    locale: 'kn',
    key: 'securityAgent.remediationUnavailable.findingNotOpen',
    value: 'ಪತ್ತೆಯಾದ ಸಮಸ್ಯೆ ಇನ್ನು ಓಪನ್ ಆಗಿಲ್ಲ.',
  },
  {
    locale: 'ko',
    key: 'securityAgent.remediationUnavailable.findingNotOpen',
    value: '이 문제는 더 이상 오픈 상태가 아닙니다.',
  },
  {
    locale: 'ml',
    key: 'securityAgent.remediationUnavailable.findingNotOpen',
    value: 'ഈ കണ്ടെത്തൽ ഇനി ഓപ്പണിൽ അല്ല.',
  },
  {
    locale: 'mr',
    key: 'securityAgent.remediationUnavailable.findingNotOpen',
    value: 'हा निष्कर्ष आता उघडा नाही.',
  },
  {
    locale: 'my',
    key: 'securityAgent.remediationUnavailable.findingNotOpen',
    value: 'ဤတွေ့ရှိချက်သည် ဖွင့်ထားခြင်း မရှိတော့ပါ။',
  },
  {
    locale: 'or',
    key: 'securityAgent.remediationUnavailable.findingNotOpen',
    value: 'ଚିହ୍ନଟ ସମସ୍ୟା ଆଉ ଖୋଲା ନାହିଁ।',
  },
  {
    locale: 'ta',
    key: 'securityAgent.remediationUnavailable.findingNotOpen',
    value: 'இந்தச் சிக்கல் இனி திறந்ததாக இல்லை.',
  },
  {
    locale: 'te',
    key: 'securityAgent.remediationUnavailable.findingNotOpen',
    value: 'ఈ సమస్య ఇక ఓపెన్‌లో లేదు.',
  },
  {
    locale: 'ur',
    key: 'securityAgent.remediationUnavailable.findingNotOpen',
    value: 'مسئلہ اب کھلا نہیں ہے۔',
  },
  {
    locale: 'vi',
    key: 'securityAgent.remediationUnavailable.findingNotOpen',
    value: 'Vấn đề này không còn mở nữa.',
  },
  {
    locale: 'zh-Hant',
    key: 'securityAgent.remediationUnavailable.findingNotOpen',
    value: '這項資安問題已不再開啟。',
  },
];

const LOCALES = [...new Set(CASES.map(c => c.locale))];

beforeAll(async () => {
  await Promise.all(LOCALES.map(locale => i18n.loadLanguages(locale)));
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe('Security Agent copy that misstated the English meaning', () => {
  it.each(CASES)('$locale reads $value at $key', async ({ locale, key, value }) => {
    await i18n.changeLanguage(locale);
    expect(i18n.t(key)).toBe(value);
  });
});
