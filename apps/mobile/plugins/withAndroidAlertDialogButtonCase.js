const { withAndroidStyles } = require('expo/config-plugins');

/**
 * Renders Android alert-dialog actions in the app's sentence case.
 *
 * `Alert.alert()` on Android goes through AppCompat's `AlertDialog`, whose
 * button bar inflates the positive/negative/neutral actions with
 * `style="?attr/buttonBarPositiveButtonStyle"` (and Negative/Neutral). The
 * AppCompat theme resolves all three to `?attr/buttonBarButtonStyle` =
 * `Widget.AppCompat.Button.ButtonBar.AlertDialog`, whose text-appearance chain
 * ends at `Base.TextAppearance.AppCompat.Button` with
 * `android:textAllCaps=true` — so the confirm's actions draw ALL-CAPS
 * ("CONTINUA A MODIFICARE" / "SCARTA") while every other button in the app is
 * sentence case. DESIGN.md:350: "Use sentence case for user-visible copy.
 * Eyebrows are the exception because the token explicitly transforms them to
 * uppercase."
 *
 * The override belongs on the activity theme (AppTheme) because that is the
 * theme the dialog resolves the three attrs against. AppCompat's
 * `alertDialogTheme` is `@style/ThemeOverlay.AppCompat.Dialog.Alert`, a
 * ThemeOverlay whose chain (`Base.ThemeOverlay.AppCompat.Dialog.Alert` ->
 * `Base.ThemeOverlay.AppCompat.Dialog` -> `Base.V7.ThemeOverlay.AppCompat.Dialog`
 * -> `Base.ThemeOverlay.AppCompat` -> `Platform.ThemeOverlay.AppCompat`,
 * `parent=""`) carries only the dialog's window properties, none of the three
 * `buttonBar*ButtonStyle` attrs. `AlertDialog.Builder` wraps the activity in a
 * `ContextThemeWrapper` that copies the activity theme and applies that overlay
 * on top of it (`Resources.Theme.setTo` then `applyStyle(resid, true)`), so an
 * attr the overlay does not define falls through to AppTheme — where the stock
 * values live anyway (`Base.V7.Theme.AppCompat` points the three attrs at
 * `?attr/buttonBarButtonStyle` = the ALL-CAPS `Widget.AppCompat.Button.ButtonBar.AlertDialog`).
 * No custom `alertDialogTheme` is needed, and writing one would only risk losing
 * the overlay's window properties.
 *
 * The fix re-cases the actions: the three `buttonBar*ButtonStyle` attrs are
 * pointed at `AppAlertDialogButton`, a style that keeps the stock parent
 * (`Widget.AppCompat.Button.ButtonBar.AlertDialog`) and sets only
 * `android:textAllCaps=false`. AOSP `TextView`'s constructor reads the
 * `textAppearance` first and the view's own attributes from its `style` chain
 * after (`readTextAppearance(appearance, …, false)` then
 * `readTextAppearance(a, …, true)`), and `sAppearanceValues` maps
 * `TextView_textAllCaps` onto `TextAppearance_textAllCaps` with the
 * already-read value as the default, so an explicit `false` in the button's
 * style overrides the appearance's `true`. Keeping the stock parent is what
 * preserves the button bar's metrics and colors (`android:minWidth` 64dp,
 * `android:minHeight` `@dimen/abc_alert_dialog_button_bar_height`, the
 * borderless-colored text color) — only the case changes, so the row's layout
 * is byte-identical.
 *
 * Android is the only platform with this behaviour and the only
 * platform-specific piece on the path: iOS renders the same `Alert.alert()`
 * call as `UIAlertController`, which draws the app's copy as given and exposes
 * no casing override. There is deliberately no iOS half and no `Platform.OS`
 * branch anywhere on this path (apps/mobile/AGENTS.md: prefer native sheets and
 * alerts; confirm destructive actions with `Alert.alert()`).
 */

const THEME_NAME = 'AppTheme';
const BUTTON_STYLE_NAME = 'AppAlertDialogButton';
const BUTTON_STYLE_PARENT = 'Widget.AppCompat.Button.ButtonBar.AlertDialog';
const BUTTON_BAR_STYLE_ITEMS = [
  'buttonBarPositiveButtonStyle',
  'buttonBarNegativeButtonStyle',
  'buttonBarNeutralButtonStyle',
];
const TEXT_ALL_CAPS_ITEM = 'android:textAllCaps';

function setItem(theme, name, value) {
  theme.item ??= [];
  const existing = theme.item.find(item => item.$?.name === name);
  if (existing) {
    existing._ = value;
    return;
  }
  theme.item.push({ $: { name }, _: value });
}

function withAlertDialogButtonCaseStyles(config) {
  return withAndroidStyles(config, config => {
    const themes = config.modResults.resources.style ?? [];
    const appTheme = themes.find(theme => theme.$?.name === THEME_NAME);
    if (!appTheme) {
      return config;
    }
    let buttonStyle = themes.find(theme => theme.$?.name === BUTTON_STYLE_NAME);
    if (!buttonStyle) {
      buttonStyle = { $: { name: BUTTON_STYLE_NAME, parent: BUTTON_STYLE_PARENT } };
      themes.push(buttonStyle);
    }
    setItem(buttonStyle, TEXT_ALL_CAPS_ITEM, 'false');
    for (const item of BUTTON_BAR_STYLE_ITEMS) {
      setItem(appTheme, item, `@style/${BUTTON_STYLE_NAME}`);
    }
    return config;
  });
}

const withAndroidAlertDialogButtonCase = withAlertDialogButtonCaseStyles;

module.exports = withAndroidAlertDialogButtonCase;
