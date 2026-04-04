import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { entries } from './entries';

type Viewport = 'desktop' | 'mobile';

/**
 * Renders children inside an iframe so Tailwind `sm:` breakpoints
 * respond to the iframe's viewport width, not the outer page's.
 */
function IsolatedFrame({ width, children }: { width: number; children: React.ReactNode }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [mountNode, setMountNode] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const onLoad = () => {
      const doc = iframe.contentDocument;
      if (!doc) return;

      // Copy all stylesheets from parent into iframe
      const parentStyles = document.querySelectorAll('style, link[rel="stylesheet"]');
      parentStyles.forEach((node) => {
        doc.head.appendChild(node.cloneNode(true));
      });

      // Match dark mode
      doc.documentElement.classList.add('dark');
      doc.body.style.background = 'transparent';
      doc.body.style.margin = '0';
      doc.body.style.colorScheme = 'dark';

      // Create mount point
      let root = doc.getElementById('iframe-root');
      if (!root) {
        root = doc.createElement('div');
        root.id = 'iframe-root';
        doc.body.appendChild(root);
      }
      setMountNode(root);
    };

    iframe.addEventListener('load', onLoad);
    // Trigger for about:blank
    if (iframe.contentDocument?.readyState === 'complete') onLoad();

    return () => iframe.removeEventListener('load', onLoad);
  }, []);

  // Auto-resize iframe height to content
  useEffect(() => {
    if (!mountNode) return;
    const observer = new ResizeObserver(() => {
      const iframe = iframeRef.current;
      if (!iframe || !mountNode) return;
      iframe.style.height = mountNode.scrollHeight + 'px';
    });
    observer.observe(mountNode);
    return () => observer.disconnect();
  }, [mountNode]);

  return (
    <>
      <iframe
        ref={iframeRef}
        src="about:blank"
        style={{ width, border: 'none', display: 'block', minHeight: 60 }}
        title="preview"
      />
      {mountNode && createPortal(children, mountNode)}
    </>
  );
}

function PreviewPanel({
  label,
  borderColor,
  labelColor,
  content,
  viewport,
}: {
  label: string;
  borderColor: string;
  labelColor: string;
  content: React.ReactNode;
  viewport: Viewport;
}) {
  const width = viewport === 'mobile' ? 375 : undefined;

  return (
    <div className={`rounded-xl border ${borderColor} p-4`}>
      <div className={`text-[10px] uppercase tracking-widest ${labelColor} mb-3 font-semibold`}>{label}</div>
      {width ? (
        <IsolatedFrame width={width}>{content}</IsolatedFrame>
      ) : (
        content
      )}
    </div>
  );
}

export function App() {
  const [activeTab, setActiveTab] = useState(0);
  const [activeVariant, setActiveVariant] = useState(0);
  const [viewport, setViewport] = useState<Viewport>('desktop');

  const current = entries[activeTab];
  const variant = current.variants[activeVariant];

  return (
    <div className="flex min-h-screen flex-col">
      {/* Top bar */}
      <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <h1 className="text-sm font-bold tracking-tight">Banner Standardization</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setViewport('desktop')}
            className={`cursor-pointer rounded px-3 py-1 text-xs font-medium transition-colors ${viewport === 'desktop' ? 'bg-white/15 text-white' : 'text-muted-foreground hover:text-white'}`}
          >
            Desktop
          </button>
          <button
            onClick={() => setViewport('mobile')}
            className={`cursor-pointer rounded px-3 py-1 text-xs font-medium transition-colors ${viewport === 'mobile' ? 'bg-white/15 text-white' : 'text-muted-foreground hover:text-white'}`}
          >
            Mobile (375px)
          </button>
        </div>
      </header>

      <div className="flex flex-1">
        {/* Sidebar */}
        <nav className="w-56 shrink-0 border-r border-white/10 p-2">
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground px-2 py-1 mb-1">Components</div>
          {entries.map((entry, i) => (
            <button
              key={entry.name}
              onClick={() => { setActiveTab(i); setActiveVariant(0); }}
              className={`w-full cursor-pointer rounded px-2 py-1.5 text-left text-sm transition-colors ${
                i === activeTab
                  ? 'bg-white/10 text-white font-medium'
                  : 'text-muted-foreground hover:bg-white/5 hover:text-white'
              }`}
            >
              {entry.name}
            </button>
          ))}
        </nav>

        {/* Main content */}
        <main className="flex-1 overflow-auto p-6">
          {/* Variant subtabs */}
          {current.variants.length > 1 && (
            <div className="mb-6 flex gap-1 border-b border-white/10 pb-2">
              {current.variants.map((v, i) => (
                <button
                  key={v.label}
                  onClick={() => setActiveVariant(i)}
                  className={`cursor-pointer rounded-t px-3 py-1.5 text-xs font-medium transition-colors ${
                    i === activeVariant
                      ? 'bg-white/10 text-white'
                      : 'text-muted-foreground hover:text-white'
                  }`}
                >
                  {v.label}
                </button>
              ))}
            </div>
          )}

          <h2 className="text-lg font-semibold mb-1">{current.name}</h2>
          {variant.label !== 'Default' && (
            <p className="text-xs text-muted-foreground mb-4">Variant: {variant.label}</p>
          )}
          <p className="text-xs text-muted-foreground mb-6">
            <code className="bg-white/10 px-1 py-0.5 rounded text-xs">{current.file}</code>
          </p>

          <div className="space-y-6">
            <PreviewPanel
              label="Before"
              borderColor="border-red-500/20 bg-red-500/5"
              labelColor="text-red-400"
              content={variant.before}
              viewport={viewport}
            />
            <PreviewPanel
              label="After"
              borderColor="border-green-500/20 bg-green-500/5"
              labelColor="text-green-400"
              content={variant.after}
              viewport={viewport}
            />
          </div>
        </main>
      </div>
    </div>
  );
}
