import i18next from 'i18next';

import af from './locales/af.json';
import am from './locales/am.json';
import ar from './locales/ar.json';
import az from './locales/az.json';
import be from './locales/be.json';
import bg from './locales/bg.json';
import bn from './locales/bn.json';
import bs from './locales/bs.json';
import ca from './locales/ca.json';
import ckb from './locales/ckb.json';
import cs from './locales/cs.json';
import cy from './locales/cy.json';
import da from './locales/da.json';
import de from './locales/de.json';
import el from './locales/el.json';
import en from './locales/en.json';
import es from './locales/es.json';
import et from './locales/et.json';
import eu from './locales/eu.json';
import fa from './locales/fa.json';
import fi from './locales/fi.json';
import fil from './locales/fil.json';
import fr from './locales/fr.json';
import ga from './locales/ga.json';
import gl from './locales/gl.json';
import gu from './locales/gu.json';
import ha from './locales/ha.json';
import he from './locales/he.json';
import hi from './locales/hi.json';
import hr from './locales/hr.json';
import ht from './locales/ht.json';
import hu from './locales/hu.json';
import hy from './locales/hy.json';
import id from './locales/id.json';
import ig from './locales/ig.json';
import is from './locales/is.json';
import it from './locales/it.json';
import ja from './locales/ja.json';
import ka from './locales/ka.json';
import kk from './locales/kk.json';
import km from './locales/km.json';
import kn from './locales/kn.json';
import ko from './locales/ko.json';
import lo from './locales/lo.json';
import lt from './locales/lt.json';
import lv from './locales/lv.json';
import mg from './locales/mg.json';
import mi from './locales/mi.json';
import mk from './locales/mk.json';
import ml from './locales/ml.json';
import mn from './locales/mn.json';
import mr from './locales/mr.json';
import ms from './locales/ms.json';
import mt from './locales/mt.json';
import my from './locales/my.json';
import nb from './locales/nb.json';
import ne from './locales/ne.json';
import nl from './locales/nl.json';
import om from './locales/om.json';
import or from './locales/or.json';
import pa from './locales/pa.json';
import pl from './locales/pl.json';
import ps from './locales/ps.json';
import pt from './locales/pt.json';
import pt_BR from './locales/pt-BR.json';
import ro from './locales/ro.json';
import ru from './locales/ru.json';
import si from './locales/si.json';
import sk from './locales/sk.json';
import sl from './locales/sl.json';
import so from './locales/so.json';
import sq from './locales/sq.json';
import sr from './locales/sr.json';
import sv from './locales/sv.json';
import sw from './locales/sw.json';
import ta from './locales/ta.json';
import te from './locales/te.json';
import th from './locales/th.json';
import tr from './locales/tr.json';
import uk from './locales/uk.json';
import ur from './locales/ur.json';
import uz from './locales/uz.json';
import vi from './locales/vi.json';
import yo from './locales/yo.json';
import zh_Hans from './locales/zh-Hans.json';
import zh_Hant from './locales/zh-Hant.json';
import zu from './locales/zu.json';

const resources = {
  af: { translation: af },
  sq: { translation: sq },
  am: { translation: am },
  ar: { translation: ar },
  hy: { translation: hy },
  az: { translation: az },
  eu: { translation: eu },
  be: { translation: be },
  bn: { translation: bn },
  bs: { translation: bs },
  bg: { translation: bg },
  my: { translation: my },
  ca: { translation: ca },
  'zh-Hans': { translation: zh_Hans },
  'zh-Hant': { translation: zh_Hant },
  hr: { translation: hr },
  cs: { translation: cs },
  da: { translation: da },
  nl: { translation: nl },
  en: { translation: en },
  et: { translation: et },
  fil: { translation: fil },
  fi: { translation: fi },
  fr: { translation: fr },
  gl: { translation: gl },
  ka: { translation: ka },
  de: { translation: de },
  el: { translation: el },
  gu: { translation: gu },
  ht: { translation: ht },
  ha: { translation: ha },
  he: { translation: he },
  hi: { translation: hi },
  hu: { translation: hu },
  is: { translation: is },
  ig: { translation: ig },
  id: { translation: id },
  ga: { translation: ga },
  it: { translation: it },
  ja: { translation: ja },
  kn: { translation: kn },
  kk: { translation: kk },
  km: { translation: km },
  ko: { translation: ko },
  ckb: { translation: ckb },
  lo: { translation: lo },
  lv: { translation: lv },
  lt: { translation: lt },
  mk: { translation: mk },
  mg: { translation: mg },
  ms: { translation: ms },
  ml: { translation: ml },
  mt: { translation: mt },
  mi: { translation: mi },
  mr: { translation: mr },
  mn: { translation: mn },
  ne: { translation: ne },
  nb: { translation: nb },
  or: { translation: or },
  om: { translation: om },
  ps: { translation: ps },
  fa: { translation: fa },
  pl: { translation: pl },
  pt: { translation: pt },
  'pt-BR': { translation: pt_BR },
  pa: { translation: pa },
  ro: { translation: ro },
  ru: { translation: ru },
  sr: { translation: sr },
  si: { translation: si },
  sk: { translation: sk },
  sl: { translation: sl },
  so: { translation: so },
  es: { translation: es },
  sw: { translation: sw },
  sv: { translation: sv },
  ta: { translation: ta },
  te: { translation: te },
  th: { translation: th },
  tr: { translation: tr },
  uk: { translation: uk },
  ur: { translation: ur },
  uz: { translation: uz },
  vi: { translation: vi },
  cy: { translation: cy },
  yo: { translation: yo },
  zu: { translation: zu },
};

const i18n = i18next.createInstance();
void i18n.init({
  resources,
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  initAsync: false,
  returnNull: false,
});

/**
 * Resolve a stored token locale to a catalog tag. Null and unsupported tags
 * fall back to English; a token with no locale is treated as English.
 */
export function resolvePushLocale(locale: string | null | undefined): string {
  if (locale != null && locale in resources) return locale;
  return 'en';
}

/**
 * Translate a catalog key for a push locale. Unknown locales use English.
 * An unknown key returns `fallback` when provided; otherwise it returns the
 * key itself (test-only convenience — production callers pass a fallback).
 */
export function translatePush(
  locale: string | null | undefined,
  key: string,
  params?: Record<string, string>,
  fallback?: string
): string {
  const lng = resolvePushLocale(locale);
  return i18n.t(key, { ...params, lng, defaultValue: fallback ?? key });
}
