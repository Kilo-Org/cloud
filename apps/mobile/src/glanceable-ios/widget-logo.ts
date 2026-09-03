import type * as ExpoFileSystem from 'expo-file-system';
// eslint-disable-next-line no-restricted-imports -- the asset resolver, not the Image component
import { Image } from 'react-native';
import { widgetsDirectory } from 'expo-widgets';

/**
 * The Kilo mark the Live Activity and the widgets draw.
 *
 * The widget extension is a separate process: it cannot resolve a bundle asset,
 * and the Live Activity content-state cannot carry the path either, because the
 * notifications Worker produces the same shape and knows no device path. So the
 * mark is copied into the shared app group once and its absolute path is baked
 * into the stringified layouts at registration time — see `withWidgetLogo`.
 */

const LOGO_FILE_NAME = 'kilo-logo.png';

/**
 * The token the `'widget'` layouts carry until `withWidgetLogo` resolves it.
 *
 * Each layout repeats this literal inline rather than importing it: the widget
 * transform stringifies the layout source, so an imported binding would be an
 * undefined global in the widget process. `widget-logo.test.ts` keeps the two
 * copies equal.
 */
const WIDGET_LOGO_PLACEHOLDER = '__KILO_WIDGET_LOGO_URI__';

// `widgetsDirectory` is typed `string`, but the iOS constant returns `String?`
// (nil without an app group) and the native module is absent on Android, so the
// value really is nullable.
const appGroupDirectory = widgetsDirectory as string | null;

/** App-group path of the copied mark; empty when the app group is unavailable. */
const WIDGET_LOGO_URI = appGroupDirectory === null ? '' : `${appGroupDirectory}${LOGO_FILE_NAME}`;

/**
 * Resolve the logo placeholder inside a stringified `'widget'` layout.
 *
 * This is the boundary between two representations of one value: Babel's
 * widget plugin replaces a `'widget'` function with a template literal of its
 * source, so the layout is a string in the app, while a unit test (which runs
 * no widget transform) still holds the real function. Only the string form
 * carries a placeholder to patch.
 */
export function withWidgetLogo<T>(layout: T): T {
  // eslint-disable-next-line anti-slop/no-runtime-typeof -- the two representations are the contract; see above
  if (typeof layout !== 'string') {
    return layout;
  }
  const patched = layout.split(WIDGET_LOGO_PLACEHOLDER).join(WIDGET_LOGO_URI);
  // eslint-disable-next-line anti-slop/no-chained-type-assertions -- the layout source IS the component to expo-widgets
  return patched as unknown as T;
}

let copy: Promise<void> | null = null;

/**
 * Copy the bundled mark into the app group once per process. Idempotent and
 * best effort: on failure the surfaces render without a logo, and the promise
 * never rejects into a caller.
 */
export async function ensureWidgetLogo(): Promise<void> {
  copy ??= copyLogo();
  await copy;
}

async function copyLogo(): Promise<void> {
  try {
    if (WIDGET_LOGO_URI === '') {
      return;
    }
    // Lazy require keeps expo-file-system's native module out of the pure test
    // graph, the same reason the sink registry defers its Sentry import.
    // eslint-disable-next-line typescript-eslint/no-require-imports, typescript-eslint/no-var-requires, unicorn/prefer-module -- lazy native load
    const { File } = require('expo-file-system') as typeof ExpoFileSystem;
    const target = new File(WIDGET_LOGO_URI);
    if (target.exists) {
      return;
    }
    // eslint-disable-next-line typescript-eslint/no-require-imports, typescript-eslint/no-var-requires, unicorn/prefer-module -- the Metro asset registry needs a static require
    const assetModule = require('../../assets/images/logo-widget.png') as number;
    const asset = Image.resolveAssetSource(assetModule);
    if (asset.uri.startsWith('file://')) {
      // Release build: the asset is a file inside the app bundle.
      new File(asset.uri).copySync(target, { overwrite: true });
      return;
    }
    // Dev build: the asset is served by Metro over HTTP.
    await File.downloadFileAsync(asset.uri, target, { idempotent: true });
  } catch {
    // A missing logo is cosmetic; every surface renders without it.
  }
}
