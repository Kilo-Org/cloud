import { describe, expect, it } from 'vitest';

import { rewriteWidgetProviderCategory } from '../../plugins/android-widget-category';

/**
 * The provider XML react-native-android-widget's `withWidgetProviderXml` writes
 * (shape copied from its source), with the four-cell target the large cell asks
 * for. The library hardcodes `home_screen`, so this rewrite is the only way the
 * widget reaches the Android 15 QPR1+ lock-screen host.
 */
const PROVIDER_XML = `<?xml version="1.0" encoding="utf-8"?>
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:minWidth="110dp"
    android:minHeight="40dp"
    android:targetCellWidth="4"
    android:targetCellHeight="4"
    android:resizeMode="horizontal|vertical"

    android:description="@string/widget_activeagentswidget_description"

    android:initialLayout="@layout/rn_widget"

    android:updatePeriodMillis="0"
    android:widgetCategory="home_screen">
</appwidget-provider>
`;

describe('rewriteWidgetProviderCategory', () => {
  it('declares the keyguard host beside the home screen', () => {
    const rewritten = rewriteWidgetProviderCategory(PROVIDER_XML);

    expect(rewritten).toContain('android:widgetCategory="home_screen|keyguard"');
    // The rest of the provider is the library's to write.
    expect(rewritten).toContain('android:targetCellHeight="4"');
    expect(rewritten).toContain('android:resizeMode="horizontal|vertical"');
    expect(rewritten).toBe(
      PROVIDER_XML.replace(
        'android:widgetCategory="home_screen"',
        'android:widgetCategory="home_screen|keyguard"'
      )
    );
  });

  it('leaves an already-rewritten provider alone', () => {
    const once = rewriteWidgetProviderCategory(PROVIDER_XML);

    expect(rewriteWidgetProviderCategory(once)).toBe(once);
  });

  it('leaves a provider without the attribute alone', () => {
    const withoutCategory = PROVIDER_XML.replace('    android:widgetCategory="home_screen">', '>');

    expect(rewriteWidgetProviderCategory(withoutCategory)).toBe(withoutCategory);
  });
});
