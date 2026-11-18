export const MERMAID_VERSION = '11.12.0';
export const SCRIPT_FILE_NAME = `mermaid-${MERMAID_VERSION}.js`;

/**
 * The static page every diagram loads. It renders nothing until the app
 * calls `window.kiloRenderDiagram` with the diagram source and colors.
 *
 * One page serves its diagram for as long as the view is mounted: a colors
 * change re-renders into the same page instead of reloading it, so the vendored
 * script is read once per diagram. The page keeps one `ResizeObserver` on the
 * diagram host and coalesces render requests — a request arriving while a
 * `mermaid.render` runs becomes the one follow-up render — so two renders never
 * run against the same element id at once.
 *
 * Every message names the source it belongs to, so a report or a failure from a
 * diagram the app has already replaced is recognizable and ignored.
 */
export const HOST_PAGE = `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<style>html,body{margin:0;padding:0;}#d{display:flex;justify-content:center;}</style>
<script src="${SCRIPT_FILE_NAME}"></script></head><body><div id="d"></div><script>
const post = m => window.ReactNativeWebView.postMessage(JSON.stringify(m));
const host = document.getElementById('d');
let observing = false;
// The state the page should be painting: null when the page is up to date.
let wanted = null;
let running = false;
// The source whose SVG is in the host, so a measurement is attributable.
let painted = null;
window.kiloRenderDiagram = state => {
  wanted = state;
  paint();
};
function report() {
  post({ kind: 'height', height: Math.ceil(host.getBoundingClientRect().height), source: painted });
}
function paint() {
  if (running || wanted === null) return;
  const { source, dark, background } = wanted;
  wanted = null;
  running = true;
  document.documentElement.style.background = background;
  document.body.style.background = background;
  let rendered;
  try {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
    rendered = mermaid.render('g', source);
  } catch (e) {
    painted = null;
    running = false;
    post({ kind: 'error', source });
    return;
  }
  rendered.then(({ svg }) => {
    host.innerHTML = svg;
    painted = source;
    // The SVG scales to the page width, which can still be settling when it
    // first lays out; report the height again whenever the host resizes.
    if (!observing) {
      observing = true;
      new ResizeObserver(report).observe(host);
    }
    requestAnimationFrame(report);
  }).catch(() => {
    painted = null;
    post({ kind: 'error', source });
  }).then(() => {
    running = false;
    paint();
  });
}
</script></body></html>`;
