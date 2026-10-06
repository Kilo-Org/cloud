import { useMemo, useState } from 'react';
import { useColorScheme, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { CodeBlock } from './code-block';
import { type MarkdownPalette } from './markdown-palette';

/** The pinned Mermaid build the diagram page loads. */
const MERMAID_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/mermaid@11.12.0/dist/mermaid.min.js';
const MIN_HEIGHT = 48;

type MarkdownMermaidProps = {
  source: string;
  palette: MarkdownPalette;
};

type DiagramMessage = { kind: 'height'; height: number } | { kind: 'error' };

function diagramPage(source: string, dark: boolean, background: string): string {
  // The source travels as a JSON string literal, so diagram text never becomes markup.
  return `<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<style>html,body{margin:0;padding:0;background:${background};}#d{display:flex;justify-content:center;}</style>
<script src="${MERMAID_SCRIPT_URL}"></script></head><body><div id="d"></div><script>
const post = m => window.ReactNativeWebView.postMessage(JSON.stringify(m));
try {
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: ${dark ? "'dark'" : "'default'"} });
  mermaid.render('g', ${JSON.stringify(source)}).then(({ svg }) => {
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

/**
 * A ```mermaid fence drawn as a diagram in a WebView. A load or parse failure
 * falls back to the fence's source as a code block, so the text never disappears.
 */
export function MarkdownMermaid({ source, palette }: Readonly<MarkdownMermaidProps>) {
  const dark = useColorScheme() === 'dark';
  const [height, setHeight] = useState(MIN_HEIGHT);
  const [failed, setFailed] = useState(false);
  const html = useMemo(
    () => diagramPage(source, dark, palette.codeBackground),
    [source, dark, palette.codeBackground]
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
      <WebView
        originWhitelist={['*']}
        source={{ html }}
        scrollEnabled={false}
        // The page only loads the pinned script; every tap stays in the app.
        onShouldStartLoadWithRequest={request => request.url === 'about:blank'}
        onMessage={(event: WebViewMessageEvent) => {
          const message = JSON.parse(event.nativeEvent.data) as DiagramMessage;
          if (message.kind === 'height') {
            setHeight(Math.max(MIN_HEIGHT, message.height));
          } else {
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
    </View>
  );
}
