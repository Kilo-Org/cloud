import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useColorScheme, View } from 'react-native';
import { WebView } from 'react-native-webview';

import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { type RemoteMcpApp } from '@kilocode/harness-sdk/plugins/remote-mcp';

import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { mcpCallResultOf, openRemoteMcpApp, readRemoteMcpView } from '@/lib/chat/remote-mcp';
import {
  DEFAULT_VIEW_HEIGHT,
  MAX_VIEW_HEIGHT,
  VIEW_HOST_PAGE,
  viewArguments,
  viewHeightOf,
} from '@/lib/chat/remote-mcp-app';
import { type RemoteMcpToolView } from '@/lib/chat/remote-mcp-state';
import { deviceZone } from '@/lib/chat/tool-set';
import { openExternalUrl } from '@/lib/external-link';

import { GenericToolCard } from './generic-tool-card';

/**
 * An MCP Apps view, drawn under the tool call it belongs to.
 *
 * The tool's row is the one every tool has; the view is the interface the
 * server wrote for that call, in a WebView that loads one page of the app's
 * own: a proxy that owns a single sandboxed iframe. The view's HTML comes from
 * somebody else's server, so it runs with an opaque origin, under the policy
 * the resource declared, with no file access and no way to navigate anything
 * but itself. Everything that crosses into it or out of it is JSON text through
 * the bridge (`remote-mcp-app.ts` holds the page and the policy;
 * `openRemoteMcpApp` holds the protocol).
 *
 * The box keeps one height from the moment the row is drawn — the view's own
 * reported height inside the clamp — so a view that loads a moment after its
 * call does not move the transcript.
 */

/**
 * The page's origin in the WebView. The page is loaded from the app's own
 * memory (`source={{ html }}`), so it has no file or network origin of its own
 * to reach anything with — and nothing but it may load.
 */
const HOST_PAGE_ORIGIN = 'about:blank';

/** What the row draws: the document, or why there is none. */
type ViewState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'document'; readonly html: string }
  | { readonly kind: 'empty' }
  | { readonly kind: 'unavailable' };

/** The page's call that puts a document in the sandbox, as a JS literal. */
const mountCall = (html: string): string =>
  `window.kiloMcpHost.mount(${JSON.stringify(html)});true;`;

/** The page's call that posts one bridge message into the sandbox. */
const deliverCall = (text: string): string =>
  `window.kiloMcpHost.deliver(${JSON.stringify(text)});true;`;

type McpAppViewProps = {
  readonly part: ToolPart;
  readonly view: RemoteMcpToolView;
};

function McpAppView({ part, view }: Readonly<McpAppViewProps>) {
  const { t, i18n } = useTranslation();
  const dark = useColorScheme() === 'dark';
  const [pageLoaded, setPageLoaded] = useState(false);
  const [documentState, setDocumentState] = useState<ViewState>({ kind: 'loading' });
  const [height, setHeight] = useState(DEFAULT_VIEW_HEIGHT);
  const [attempt, setAttempt] = useState(0);

  const webView = useRef<WebView | null>(null);
  const bridge = useRef<RemoteMcpApp | null>(null);

  useEffect(() => {
    let active = true;
    setDocumentState({ kind: 'loading' });
    const read = async () => {
      const document = await readRemoteMcpView(view);
      if (!active) {
        return;
      }
      setDocumentState(
        document.kind === 'ready' ? { kind: 'document', html: document.html } : document
      );
    };
    void read();
    return () => {
      active = false;
    };
  }, [attempt, view]);

  // A retry or a new document tears the old bridge down before the new one opens.
  useEffect(
    () => () => {
      const held = bridge.current;
      bridge.current = null;
      void held?.close();
    },
    [attempt]
  );

  // The page is loaded and the document is read: connect, then let the view
  // initialize. The order matters — a view that initializes before the bridge
  // listens would never be answered.
  useEffect(() => {
    if (!pageLoaded || documentState.kind !== 'document' || bridge.current !== null) {
      return undefined;
    }
    let active = true;
    const html = documentState.html;
    const open = async () => {
      const app = openRemoteMcpApp(view, {
        context: {
          theme: dark ? 'dark' : 'light',
          locale: i18n.language,
          timeZone: deviceZone(),
          maxHeight: MAX_VIEW_HEIGHT,
        },
        openLink: uri => void openExternalUrl(uri),
      });
      if (app === undefined) {
        if (active) {
          setDocumentState({ kind: 'unavailable' });
        }
        return;
      }
      bridge.current = app;
      app.onSizeChanged(size => {
        const reported = viewHeightOf(size.height);
        setHeight(reported);
      });
      app.onInitialized(() => {
        void app.input(viewArguments(part.state.status === 'completed' ? part.state.input : {}));
        const answered = mcpCallResultOf(part.callID);
        if (answered !== undefined) {
          void app.result(answered);
        }
      });
      try {
        await app.connect({
          send: text => {
            webView.current?.injectJavaScript(deliverCall(text));
          },
        });
        webView.current?.injectJavaScript(mountCall(html));
      } catch {
        // The handshake or the mount failed: the row says so and offers a retry.
        if (active) {
          setDocumentState({ kind: 'unavailable' });
        }
      }
    };
    void open();
    return () => {
      active = false;
    };
  }, [pageLoaded, documentState, dark, i18n.language, part, view]);

  return (
    <View style={{ height }} className="overflow-hidden rounded-lg bg-secondary">
      <WebView
        ref={webView}
        source={{ html: VIEW_HOST_PAGE }}
        // Only the page itself may load; every tap stays in the app.
        originWhitelist={[HOST_PAGE_ORIGIN]}
        onShouldStartLoadWithRequest={request =>
          request.url === HOST_PAGE_ORIGIN || request.url === ''
        }
        // The view's own document is handed to the sandbox as `srcdoc`, so
        // the page reads no files and the sandbox reaches no origin.
        allowFileAccess={false}
        javaScriptCanOpenWindowsAutomatically={false}
        setSupportMultipleWindows={false}
        mixedContentMode="never"
        incognito
        scrollEnabled={false}
        accessibilityLabel={t('modelChat.mcp.app.label')}
        onLoadEnd={() => {
          setPageLoaded(true);
        }}
        onMessage={event => {
          bridge.current?.receive(event.nativeEvent.data);
        }}
        onError={() => {
          setDocumentState({ kind: 'unavailable' });
        }}
      />
      {documentState.kind === 'loading' ? (
        <View className="absolute inset-0 items-center justify-center">
          <ActivityIndicator />
        </View>
      ) : null}
      {documentState.kind === 'empty' ? (
        <View className="absolute inset-0 items-center justify-center px-4">
          <Text className="text-center text-xs text-muted-foreground">
            {t('modelChat.mcp.app.empty')}
          </Text>
        </View>
      ) : null}
      {documentState.kind === 'unavailable' ? (
        <View className="absolute inset-0 items-center justify-center gap-2 px-4">
          <Text className="text-center text-xs text-muted-foreground">
            {t('modelChat.mcp.app.failed')}
          </Text>
          <Button
            variant="secondary"
            size="sm"
            onPress={() => {
              setAttempt(current => current + 1);
            }}
          >
            <Text>{t('common.retry')}</Text>
          </Button>
        </View>
      ) : null}
    </View>
  );
}

export function McpAppToolCard({
  part,
  view,
}: Readonly<{ part: ToolPart; view: RemoteMcpToolView }>) {
  return (
    <View className="gap-2">
      <GenericToolCard part={part} />
      <McpAppView part={part} view={view} />
    </View>
  );
}
