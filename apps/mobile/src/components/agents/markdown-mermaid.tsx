import { Asset } from 'expo-asset';
import { Directory, File, Paths } from 'expo-file-system';
import { useEffect, useMemo, useState } from 'react';
import { Platform, useColorScheme, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { z } from 'zod';

import MERMAID_SCRIPT_ASSET from '@/../assets/vendor/mermaid-11.12.0.min.txt';

import { CodeBlock } from './code-block';
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
const MERMAID_VERSION = '11.12.0';
const HOST_DIRECTORY_NAME = 'mermaid-host';
const SCRIPT_FILE_NAME = `mermaid-${MERMAID_VERSION}.js`;
const PAGE_FILE_NAME = `diagram-${MERMAID_VERSION}.html`;

type MermaidHost = { pageUri: string; directoryUri: string };

let mermaidHost: Promise<MermaidHost> | null = null;

/**
 * The static page every diagram loads. It renders nothing until the app
 * calls `window.kiloRenderDiagram` with the diagram source and colors.
 */
const HOST_PAGE = `<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<style>html,body{margin:0;padding:0;}#d{display:flex;justify-content:center;}</style>
<script src="${SCRIPT_FILE_NAME}"></script></head><body><div id="d"></div><script>
const post = m => window.ReactNativeWebView.postMessage(JSON.stringify(m));
window.kiloRenderDiagram = ({ source, dark, background }) => {
  document.documentElement.style.background = background;
  document.body.style.background = background;
  try {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
    mermaid.render('g', source).then(({ svg }) => {
      const host = document.getElementById('d');
      host.innerHTML = svg;
      // The SVG scales to the page width, which can still be settling when it
      // first lays out; report the height again whenever the host resizes.
      const report = () => post({ kind: 'height', height: Math.ceil(host.getBoundingClientRect().height) });
      new ResizeObserver(report).observe(host);
      requestAnimationFrame(report);
    }).catch(() => post({ kind: 'error' }));
  } catch (e) { post({ kind: 'error' }); }
};
</script></body></html>`;

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
  page.write(HOST_PAGE);
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
  z.object({ kind: z.literal('height'), height: z.number() }),
  z.object({ kind: z.literal('error') }),
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
  const [height, setHeight] = useState(MIN_HEIGHT);
  const [failed, setFailed] = useState(false);
  const [host, setHost] = useState<MermaidHost | null>(null);
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
          setFailed(true);
        }
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, []);
  const webSource = useMemo(() => (host === null ? null : { uri: host.pageUri }), [host]);
  const webViewStyle = useMemo(
    () => ({ backgroundColor: palette.codeBackground }),
    [palette.codeBackground]
  );

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
          // A new diagram or color scheme reloads the page instead of drawing
          // a second diagram into the first one.
          key={`${source}\n${String(dark)}\n${palette.codeBackground}`}
          source={webSource}
          originWhitelist={['file://*']}
          // Android: let the file page load its sibling script. iOS: limit the
          // page's file reads to the host directory.
          allowFileAccess={Platform.OS === 'android'}
          allowingReadAccessToURL={host.directoryUri}
          injectedJavaScript={renderCall(source, dark, palette.codeBackground)}
          scrollEnabled={false}
          // Only the host page itself may load; every tap stays in the app. The
          // page is matched by name because iOS can report the cache path
          // through its `/private` alias.
          onShouldStartLoadWithRequest={request =>
            request.url.startsWith('file://') && request.url.endsWith(`/${PAGE_FILE_NAME}`)
          }
          onMessage={(event: WebViewMessageEvent) => {
            const message = parseDiagramMessage(event.nativeEvent.data);
            if (message?.kind === 'height') {
              setHeight(Math.max(MIN_HEIGHT, message.height));
            } else {
              // An error or a malformed message keeps the source as a code block.
              setFailed(true);
            }
          }}
          onError={() => {
            setFailed(true);
          }}
          // The page paints the card color itself, so the native view must not
          // flash its own white background before the diagram loads.
          style={webViewStyle}
        />
      )}
    </View>
  );
}
