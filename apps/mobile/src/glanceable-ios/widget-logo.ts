import type * as ExpoFileSystem from 'expo-file-system';
import { widgetsDirectory } from 'expo-widgets';
// eslint-disable-next-line no-restricted-imports -- the asset resolver's type, not the Image component
import type * as ReactNative from 'react-native';

/**
 * The Kilo mark the Live Activity and the widgets draw, in two forms: the full
 * mark (yellow tile, black glyphs) and a glyph-only template (white glyphs on
 * transparency) for the monochrome renderings — the Lock Screen accessories and
 * the Tinted and Clear Home Screens, which flatten an opaque tile to a blob.
 *
 * The widget extension is a separate process: it cannot resolve a bundle asset,
 * and the Live Activity content-state cannot carry a path either, because the
 * notifications Worker produces the same shape and knows no device path. So both
 * images are copied into the shared app group once and their absolute paths are
 * baked into the stringified layouts at registration time — see `withWidgetLogo`.
 */

// `widgetsDirectory` is typed `string`, but the iOS constant returns `String?`
// (nil without an app group) and the module stub is empty on Android, so the
// value really is nullable or empty. Empty means no copies and empty URIs.
const appGroupDirectory = (widgetsDirectory as string | null) ?? '';

const LOGO_PLACEHOLDER = '__KILO_WIDGET_LOGO_URI__';
const GLYPH_PLACEHOLDER = '__KILO_WIDGET_GLYPH_URI__';

/**
 * Each layout placeholder, the app-group file name that replaces it, and the
 * bundled image copied there. The asset is a thunk so the Metro asset require
 * stays out of the pure test graph.
 */
const LOGO_FILES = [
  {
    token: LOGO_PLACEHOLDER,
    fileName: 'kilo-logo.png',
    // eslint-disable-next-line typescript-eslint/no-require-imports, typescript-eslint/no-var-requires, unicorn/prefer-module -- the Metro asset registry needs a static require
    asset: () => require('../../assets/images/logo-widget.png') as number,
  },
  {
    token: GLYPH_PLACEHOLDER,
    fileName: 'kilo-logo-glyph.png',
    // eslint-disable-next-line typescript-eslint/no-require-imports, typescript-eslint/no-var-requires, unicorn/prefer-module -- the Metro asset registry needs a static require
    asset: () => require('../../assets/images/logo-widget-glyph.png') as number,
  },
];

/**
 * Resolve the logo placeholders inside a stringified `'widget'` layout.
 *
 * Each layout repeats the placeholder literals inline rather than importing
 * them: the widget transform stringifies the layout source, so an imported
 * binding would be an undefined global in the widget process.
 * `widget-logo.test.ts` keeps the copies equal.
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
  let patched: string = layout;
  for (const { token, fileName } of LOGO_FILES) {
    patched = patched
      .split(token)
      .join(appGroupDirectory === '' ? '' : `${appGroupDirectory}${fileName}`);
  }
  // eslint-disable-next-line anti-slop/no-chained-type-assertions -- the layout source IS the component to expo-widgets
  return patched as unknown as T;
}

let copy: Promise<void> | null = null;

/**
 * Copy the bundled images into the app group once per process. Idempotent and
 * best effort: on failure the surfaces render an empty logo slot, and the
 * promise never rejects into a caller.
 */
export async function ensureWidgetLogo(): Promise<void> {
  copy ??= copyLogos();
  await copy;
}

async function copyLogos(): Promise<void> {
  if (appGroupDirectory === '') {
    return;
  }
  for (const { fileName, asset } of LOGO_FILES) {
    try {
      // Lazy requires keep the native modules out of the pure test graph, which
      // imports the layouts (and so this module) under Node.
      // eslint-disable-next-line typescript-eslint/no-require-imports, typescript-eslint/no-var-requires, unicorn/prefer-module -- lazy native load
      const { File } = require('expo-file-system') as typeof ExpoFileSystem;
      // eslint-disable-next-line typescript-eslint/no-require-imports, typescript-eslint/no-var-requires, unicorn/prefer-module -- lazy native load; the asset resolver, not the Image component
      const { Image } = require('react-native') as typeof ReactNative;
      const target = new File(`${appGroupDirectory}${fileName}`);
      const source = target.exists ? null : Image.resolveAssetSource(asset());
      if (source?.uri.startsWith('file://') === true) {
        // Release build: the asset is a file inside the app bundle.
        new File(source.uri).copySync(target, { overwrite: true });
      } else if (source !== null) {
        // Dev build: the asset is served by Metro over HTTP.
        // eslint-disable-next-line no-await-in-loop -- two small files, copied one after the other
        await File.downloadFileAsync(source.uri, target, { idempotent: true });
      }
    } catch {
      // A missing logo is cosmetic; every surface keeps its empty logo slot.
    }
  }
}
