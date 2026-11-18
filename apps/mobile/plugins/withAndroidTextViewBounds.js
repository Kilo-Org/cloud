const { withAndroidStyles } = require('expo/config-plugins');

/**
 * Measures and draws every Android TextView from glyph advances, matching
 * React Native's own text measurement.
 *
 * Android 15 (API 35) made `TextView` default to `useBoundsForWidth = true`
 * for apps that target API 35+: line breaking, drawing offset and view width
 * come from glyph ink bounds instead of advances. React Native 0.86 still
 * builds its shadow-text layout from advances (`Layout.getDesiredWidth` and
 * `BoringLayout` metrics in `TextLayoutManager`), so the two disagree whenever
 * a font's glyph ink runs past its advance. A fallback font used for a script
 * the app does not ship is exactly that case: Hindi rendered through the
 * Android system font puts its final word in a line the shadow layout never
 * measured, and the view clips it although the accessibility tree and the
 * text layout report the whole label.
 *
 * The app cannot change the prebuilt ReactAndroid AAR that measures the text,
 * so it aligns the view instead: `AppTheme` points `android:textViewStyle` at
 * `AppTextView`, the appcompat text style (`Widget.AppCompat.TextView`, which
 * AppCompat itself installs in `Base.V7.Theme.AppCompat`) with
 * `android:useBoundsForWidth=false` added. `ReactTextView` is an
 * `AppCompatTextView`, whose constructor resolves `android:textViewStyle`
 * against the activity theme, so every RN text view now breaks and draws by
 * advances, the same basis React Native measures.
 *
 * The pre-15 behaviour is what the app expects: text that fits its measured
 * width renders whole. On Android 14 and below the attribute is ignored and
 * the style's only difference from the AppCompat default is that item.
 *
 * Upstream fixed this the other way in 0.83 (`8347cc4`, #54721) by measuring
 * glyph bounds in React Native, then reintroduced the clipping in 0.85
 * (react/react-native#56402). Until the installed React Native carries a
 * working fix, this plugin keeps the two sides on the same measure.
 */

const THEME_NAME = 'AppTheme';
const TEXT_STYLE_NAME = 'AppTextView';
const TEXT_STYLE_PARENT = 'Widget.AppCompat.TextView';
const TEXT_VIEW_STYLE_ITEM = 'android:textViewStyle';
const USE_BOUNDS_ITEM = 'android:useBoundsForWidth';

function setItem(style, name, value) {
  style.item ??= [];
  const existing = style.item.find(item => item.$?.name === name);
  if (existing) {
    existing._ = value;
    return;
  }
  style.item.push({ $: { name }, _: value });
}

function withTextViewBoundsStyles(config) {
  return withAndroidStyles(config, config => {
    const styles = config.modResults.resources.style ?? [];
    const appTheme = styles.find(style => style.$?.name === THEME_NAME);
    if (!appTheme) {
      return config;
    }
    let textStyle = styles.find(style => style.$?.name === TEXT_STYLE_NAME);
    if (!textStyle) {
      textStyle = { $: { name: TEXT_STYLE_NAME, parent: TEXT_STYLE_PARENT } };
      styles.push(textStyle);
    }
    setItem(textStyle, USE_BOUNDS_ITEM, 'false');
    setItem(appTheme, TEXT_VIEW_STYLE_ITEM, `@style/${TEXT_STYLE_NAME}`);
    return config;
  });
}

module.exports = withTextViewBoundsStyles;
