import { Asset } from 'expo-asset';
import { Directory, File, Paths } from 'expo-file-system';
import { type ComponentRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, useColorScheme, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { z } from 'zod';

import MERMAID_SCRIPT_ASSET from '@/../assets/vendor/mermaid-11.12.0.min.txt';

import { CodeBlock } from './code-block';
import { HOST_PAGE, MERMAID_VERSION, SCRIPT_FILE_NAME } from './markdown-mermaid-host';
import { type MarkdownPalette } from './markdown-palette';

/**
 * Mermaid 11.12.0 (`dist/mermaid.min.js`, MIT) ships with the app as an asset,
 * so a diagram never fetches code at runtime. SHA-256
 * 07e37dfa97b337ccc85365d57eddf99b9706f09db3b59b260d0333b23b343c4b, the same
 * bytes jsDelivr serves for that version.
 *
 * The script stays a file. Once per process it is copied next to a static host
 * page in the cache directory, and every diagram WebView loads that page by
 * file URL, so the 2.7 MB never enters the JS heap or crosses the bridge. Each
 * diagram sends only its own source, after the page loads. The script's file
 * name carries the version, so an app update can never pair a new page with an
 * old script. The page is app code, so it is rewritten once per process and a
 * page edit ships even when the Mermaid version stays the same.
 */
const HOST_DIRECTORY_NAME = 'mermaid-host';
const PAGE_FILE_NAME = `diagram-${MERMAID_VERSION}.html`;

type MermaidHost = { pageUri: string; directoryUri: string };

let mermaidHost: Promise<MermaidHost> | null = null;

async function prepareMermaidHost(): Promise<MermaidHost> {
  const directory = new Directory(Paths.cache, HOST_DIRECTORY_NAME);
  directory.create({ idempotent: true, intermediates: true });
  const script = new File(directory, SCRIPT_FILE_NAME);
  if (!script.exists) {
    const asset = Asset.fromModule(MERMAID_SCRIPT_ASSET);
    await asset.downloadAsync();
    await new File(asset.localUri ?? asset.uri).copy(script);
  }
  const page = new File(directory, PAGE_FILE_NAME);
  await page.write(HOST_PAGE);
  return { pageUri: page.uri, directoryUri: directory.uri };
}

async function loadMermaidHost(): Promise<MermaidHost> {
  mermaidHost ??= prepareMermaidHost();
  try {
    return await mermaidHost;
  } catch (error) {
    // A failed copy is retried by the next diagram instead of being cached.
    mermaidHost = null;
    throw error;
  }
}

const MIN_HEIGHT = 48;

type MarkdownMermaidProps = {
  source: string;
  palette: MarkdownPalette;
};

const DiagramMessageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('height'), height: z.number(), source: z.string() }),
  z.object({ kind: z.literal('error'), source: z.string() }),
]);

/**
 * The script the app runs in the loaded page. The diagram travels as a JSON
 * literal in a JS context (never as HTML), so its text cannot become markup.
 */
function renderCall(source: string, dark: boolean, background: string): string {
  return `window.kiloRenderDiagram(${JSON.stringify({ source, dark, background })});true;`;
}

/** The page's message, or undefined when it is not one the page sends. */
function parseDiagramMessage(data: string) {
  try {
    return DiagramMessageSchema.safeParse(JSON.parse(data)).data;
  } catch {
    return undefined;
  }
}

/**
 * A ```mermaid fence drawn as a diagram in a WebView. A load or parse failure
 * falls back to the fence's source as a code block, so the text never disappears.
 */
export function MarkdownMermaid({ source, palette }: Readonly<MarkdownMermaidProps>) {
  const dark = useColorScheme() === 'dark';
  // The page's imperative surface: `injectJavaScript` redraws the diagram in the
  // loaded page. `ComponentRef` is how this package's ref is typed, because its
  // JSX element infers its props type parameter from the attributes.
  const webViewRef = useRef<ComponentRef<typeof WebView> | null>(null);
  const [height, setHeight] = useState(MIN_HEIGHT);
  // A failure belongs to the source that produced it: a recycled row hands a
  // new diagram to a mounted instance, and a late host rejection or page
  // message from the superseded diagram must not mask the new one.
  const [failure, setFailure] = useState<{ source: string } | null>(null);
  const failed = failure?.source === source;
  const [host, setHost] = useState<MermaidHost | null>(null);
  // The host is prepared once per process, so a source change only re-runs this
  // after a failed copy: a failure clears the cached promise, and the retry then
  // either recovers the host or re-asserts the fallback.
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const prepared = await loadMermaidHost();
        if (active) {
          setHost(prepared);
        }
      } catch {
        if (active) {
          setFailure({ source });
        }
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [source]);
  const webSource = useMemo(() => (host === null ? null : { uri: host.pageUri }), [host]);
  const webViewStyle = useMemo(
    () => ({ backgroundColor: palette.codeBackground }),
    [palette.codeBackground]
  );
  // What the page should be painting. The load handler and the color effect both
  // read it, so the injection that follows a load carries the colors in effect by
  // then instead of the ones a prop had while the page was loading.
  const wantedRender = useRef({ source, dark, background: palette.codeBackground });
  // The source whose diagram the loaded page is drawing, or `null` while the
  // page is loading or has failed. A color change may redraw a loaded page; a
  // source change remounts the page and its own load draws the new diagram.
  const loadedSource = useRef<string | null>(null);
  // Every source change starts a fresh render attempt: drop the previous
  // diagram's failure and measured height synchronously during render (React's
  // "adjust state when a prop changes" pattern), and forget the loaded page with
  // them. A source that comes back gets its own attempt rather than a failure
  // recorded for an earlier one, and a source that cycles back to a value the
  // previous page carried cannot inject into the page that is loading for it.
  const [prevSource, setPrevSource] = useState(source);
  if (prevSource !== source) {
    setPrevSource(source);
    setFailure(null);
    setHeight(MIN_HEIGHT);
    loadedSource.current = null;
  }
  const injectWantedRender = useCallback(() => {
    const { source: wantedSource, dark: wantedDark, background } = wantedRender.current;
    webViewRef.current?.injectJavaScript(renderCall(wantedSource, wantedDark, background));
  }, []);
  // Redraw into the page already loaded when the color scheme or the palette
  // changes, instead of reloading it: the vendored script is then read once per
  // diagram rather than once per theme flip or palette change.
  useEffect(() => {
    wantedRender.current = { source, dark, background: palette.codeBackground };
    if (loadedSource.current === source) {
      injectWantedRender();
    }
  }, [source, dark, palette.codeBackground, injectWantedRender]);

  if (failed) {
    return (
      <CodeBlock
        code={source}
        language="mermaid"
        baseColor={palette.textColor}
        tokenScheme={palette.codeTokenScheme}
      />
    );
  }

  return (
    <View
      className="my-1 overflow-hidden rounded-lg"
      style={{ height, backgroundColor: palette.codeBackground }}
    >
      {host === null || webSource === null ? null : (
        <WebView
          // The page is per diagram: a source change remounts it, while the
          // colors reach it through the injection above.
          key={source}
          ref={webViewRef}
          source={webSource}
          originWhitelist={['file://*']}
          // Android: let the file page load its sibling script. iOS: limit the
          // page's file reads to the host directory.
          allowFileAccess={Platform.OS === 'android'}
          allowingReadAccessToURL={host.directoryUri}
          scrollEnabled={false}
          // Only the host page itself may load; every tap stays in the app. The
          // page is matched by name because iOS can report the cache path
          // through its `/private` alias.
          onShouldStartLoadWithRequest={request =>
            request.url.startsWith('file://') && request.url.endsWith(`/${PAGE_FILE_NAME}`)
          }
          onLoadStart={() => {
            loadedSource.current = null;
          }}
          onLoadEnd={() => {
            loadedSource.current = source;
            injectWantedRender();
          }}
          onMessage={(event: WebViewMessageEvent): void => {
            const message = parseDiagramMessage(event.nativeEvent.data);
            if (message === undefined) {
              // A malformed message keeps the source as a code block.
              setFailure({ source });
            } else if (message.source === source) {
              if (message.kind === 'height') {
                setHeight(Math.max(MIN_HEIGHT, message.height));
              } else {
                // A failed render keeps the source as a code block.
                setFailure({ source });
              }
            }
            // A message from a diagram that was replaced is ignored: it carries
            // the source it belongs to, so its height or failure cannot speak
            // for the diagram now in the page.
          }}
          onError={() => {
            loadedSource.current = null;
            setFailure({ source });
          }}
          // The page paints the card color itself, so the native view must not
          // flash its own white background before the diagram loads.
          style={webViewStyle}
        />
      )}
    </View>
  );
}
