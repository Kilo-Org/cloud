import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import { useEffect, useMemo, useState } from 'react';
import { useColorScheme, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { z } from 'zod';

import MERMAID_SCRIPT_ASSET from '@/../assets/vendor/mermaid-11.12.0.min.txt';

import { CodeBlock } from './code-block';
import { type MarkdownPalette } from './markdown-palette';

/**
 * Mermaid 11.12.0 (`dist/mermaid.min.js`, MIT) ships with the app as an asset,
 * so a diagram never fetches code at runtime. SHA-256
 * 07e37dfa97b337ccc85365d57eddf99b9706f09db3b59b260d0333b23b343c4b, the same
 * bytes jsDelivr serves for that version. It is read once per process and
 * inlined into each diagram page.
 */
let mermaidScript: Promise<string> | null = null;

async function readMermaidScript(): Promise<string> {
  const asset = Asset.fromModule(MERMAID_SCRIPT_ASSET);
  await asset.downloadAsync();
  const text = await new File(asset.localUri ?? asset.uri).text();
  // An inline script ends at the first `</script` in any letter case; escape
  // each one so the library cannot close its own element.
  return text.replaceAll(/<\/(?=script)/gi, String.raw`<\/`);
}

async function loadMermaidScript(): Promise<string> {
  mermaidScript ??= readMermaidScript();
  try {
    return await mermaidScript;
  } catch (error) {
    // A failed read is retried by the next diagram instead of being cached.
    mermaidScript = null;
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

function diagramPage({
  script,
  source,
  dark,
  background,
}: {
  script: string;
  source: string;
  dark: boolean;
  background: string;
}): string {
  // The source travels as a JSON string literal with `<` escaped, so diagram
  // text never becomes markup and a `</script>` in it cannot close the script.
  const sourceLiteral = JSON.stringify(source).replaceAll('<', String.raw`\u003C`);
  return `<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<style>html,body{margin:0;padding:0;background:${background};}#d{display:flex;justify-content:center;}</style>
<script>${script}</script></head><body><div id="d"></div><script>
const post = m => window.ReactNativeWebView.postMessage(JSON.stringify(m));
try {
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: ${dark ? "'dark'" : "'default'"} });
  mermaid.render('g', ${sourceLiteral}).then(({ svg }) => {
    const host = document.getElementById('d');
    host.innerHTML = svg;
    // The SVG scales to the page width, which can still be settling when it
    // first lays out; report the height again whenever the host resizes.
    const report = () => post({ kind: 'height', height: Math.ceil(host.getBoundingClientRect().height) });
    new ResizeObserver(report).observe(host);
    requestAnimationFrame(report);
  }).catch(() => post({ kind: 'error' }));
} catch (e) { post({ kind: 'error' }); }
</script></body></html>`;
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
  const [script, setScript] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const text = await loadMermaidScript();
        if (active) {
          setScript(text);
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
  const html = useMemo(
    () =>
      script === null
        ? null
        : diagramPage({ script, source, dark, background: palette.codeBackground }),
    [script, source, dark, palette.codeBackground]
  );
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
      {html === null ? null : (
        <WebView
          originWhitelist={['*']}
          source={{ html }}
          scrollEnabled={false}
          // The page needs no network; every navigation stays in the app.
          onShouldStartLoadWithRequest={request => request.url === 'about:blank'}
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
