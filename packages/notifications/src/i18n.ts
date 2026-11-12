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

/**
 * The push locale registry: one entry per catalog file, keyed by the locale tag
 * a stored device token carries. `resources` below and `resolvePushLocale` read
 * this one map, so a catalog is registered for translation exactly when it can
 * be resolved, and a supported tag always has its messages behind it. Three
 * tags differ from their import name because a file name cannot carry a hyphen.
 *
 * `tools/i18n/check-catalogs.mjs` fails when this map, the `./locales` imports
 * and the catalog files disagree.
 */
const pushCatalogs = {
  af,
  sq,
  am,
  ar,
  hy,
  az,
  eu,
  be,
  bn,
  bs,
  bg,
  my,
  ca,
  'zh-Hans': zh_Hans,
  'zh-Hant': zh_Hant,
  hr,
  cs,
  da,
  nl,
  en,
  et,
  fil,
  fi,
  fr,
  gl,
  ka,
  de,
  el,
  gu,
  ht,
  ha,
  he,
  hi,
  hu,
  is,
  ig,
  id,
  ga,
  it,
  ja,
  kn,
  kk,
  km,
  ko,
  ckb,
  lo,
  lv,
  lt,
  mk,
  mg,
  ms,
  ml,
  mt,
  mi,
  mr,
  mn,
  ne,
  nb,
  or,
  om,
  ps,
  fa,
  pl,
  pt,
  'pt-BR': pt_BR,
  pa,
  ro,
  ru,
  sr,
  si,
  sk,
  sl,
  so,
  es,
  sw,
  sv,
  ta,
  te,
  th,
  tr,
  uk,
  ur,
  uz,
  vi,
  cy,
  yo,
  zu,
};

const resources = Object.fromEntries(
  Object.entries(pushCatalogs).map(([locale, translation]) => [locale, { translation }])
);

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
  if (locale != null && Object.hasOwn(pushCatalogs, locale)) return locale;
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
