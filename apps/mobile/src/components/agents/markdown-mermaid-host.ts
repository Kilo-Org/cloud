export const MERMAID_VERSION = '11.12.0';
export const SCRIPT_FILE_NAME = `mermaid-${MERMAID_VERSION}.js`;

/**
 * The static page every diagram loads. It renders nothing until the app
 * calls `window.kiloRenderDiagram` with the diagram source and colors.
 */
export const HOST_PAGE = `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'">
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
