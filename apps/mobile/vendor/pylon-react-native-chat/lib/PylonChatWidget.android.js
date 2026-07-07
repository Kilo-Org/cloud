"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.PylonChatWidget = void 0;
const react_1 = __importStar(require("react"));
const react_native_1 = require("react-native");
const PylonChatView_1 = require("./PylonChatView");
/**
 * Android implementation using proxy-based touch pass-through.
 *
 * State Management:
 * - isChatOpen is ONLY set by native events (onChatOpened/onChatClosed)
 * - Imperative methods (openChat/closeChat) call native, which then fires events
 * - This ensures state is always synced with native layer
 *
 * Touch Pass-Through Strategy:
 * 1. Native reports interactive element positions via onInteractiveBoundsChanged
 * 2. React renders clickable Pressable views at those positions
 * 3. When chat is closed: WebView has pointerEvents="none" (passes touches through)
 * 4. Touches hit background OR proxy
 * 5. Proxy clicked → calls openChat() → fires onChatOpened → state updates → WebView enabled
 */
exports.PylonChatWidget = (0, react_1.forwardRef)(({ config, user, listener, style, topInset }, ref) => {
    // State synced ONLY via native events - single source of truth
    // TODO: Consider useSyncExternalStore for a more resilient solution in the future.
    const [isChatOpen, setIsChatOpen] = (0, react_1.useState)(false);
    const [interactiveBounds, setInteractiveBounds] = (0, react_1.useState)([]);
    // Internal ref has additional methods not exposed to SDK users.
    const chatRef = (0, react_1.useRef)(null);
    // Forward ref methods - these call native, which fires events that update state
    // CRITICAL: DO NOT set state directly here - let events handle it
    (0, react_1.useImperativeHandle)(ref, () => ({
        openChat: () => {
            chatRef.current?.openChat();
        },
        closeChat: () => {
            chatRef.current?.closeChat();
        },
        showChatBubble: () => chatRef.current?.showChatBubble(),
        hideChatBubble: () => chatRef.current?.hideChatBubble(),
        showNewMessage: (message, isHtml) => chatRef.current?.showNewMessage(message, isHtml),
        setNewIssueCustomFields: (fields) => chatRef.current?.setNewIssueCustomFields(fields),
        setTicketFormFields: (fields) => chatRef.current?.setTicketFormFields(fields),
        updateEmailHash: (emailHash) => chatRef.current?.updateEmailHash(emailHash),
        showTicketForm: (slug) => chatRef.current?.showTicketForm(slug),
        showKnowledgeBaseArticle: (articleId) => chatRef.current?.showKnowledgeBaseArticle(articleId),
    }));
    // CRITICAL: State is ONLY updated by these event handlers.
    // The flow is: imperative method → native JS call → Pylon widget event → native callback → React event.
    const handleChatOpened = (0, react_1.useCallback)(() => {
        setIsChatOpen(true);
        listener?.onChatOpened?.();
    }, [listener]);
    const handleChatClosed = (0, react_1.useCallback)((wasOpen) => {
        setIsChatOpen(false);
        listener?.onChatClosed?.(wasOpen);
    }, [listener]);
    const handleBoundsChanged = (0, react_1.useCallback)((bounds) => {
        setInteractiveBounds((prev) => {
            const existing = prev.findIndex((b) => b.selector === bounds.selector);
            // If bounds are 0,0,0,0 it means element is hidden - remove it
            const isHidden = bounds.left === 0 &&
                bounds.top === 0 &&
                bounds.right === 0 &&
                bounds.bottom === 0;
            if (existing >= 0) {
                const updated = [...prev];
                if (isHidden) {
                    updated.splice(existing, 1);
                }
                else {
                    updated[existing] = bounds;
                }
                return updated;
            }
            if (isHidden) {
                return prev;
            }
            return [...prev, bounds];
        });
    }, []);
    const handleProxyPress = (0, react_1.useCallback)((selector) => {
        // Trigger a click on the WebView element by its ID selector.
        // This kind of only works for areas with a single clickable element.
        // Really what htis needs to become is pass a coordinate to the webview, we look up whatever thing is at that
        // coordinate, and click it. Which is very sophisticated and hacky.
        chatRef.current?.clickElementAtSelector(selector);
    }, []);
    return (<>
      <react_native_1.View style={[react_native_1.StyleSheet.absoluteFill, style]} pointerEvents={isChatOpen ? "auto" : "none"}>
        {/* The actual WebView - disabled when chat is closed */}
        <PylonChatView_1.PylonChatView ref={chatRef} style={react_native_1.StyleSheet.absoluteFillObject} config={config} user={user} topInset={topInset} listener={{
            ...listener,
            onChatOpened: handleChatOpened,
            onChatClosed: handleChatClosed,
            onInteractiveBoundsChanged: handleBoundsChanged,
        }}/>
      </react_native_1.View>
      {!isChatOpen &&
            interactiveBounds.map((bounds, index) => (<react_native_1.Pressable key={`${bounds.selector}-${index}`} style={{
                    position: "absolute",
                    left: bounds.left,
                    top: bounds.top,
                    width: bounds.right - bounds.left,
                    height: bounds.bottom - bounds.top,
                    backgroundColor: __DEV__ && config.debugMode ? "rgba(0,255,0,0.2)" : undefined,
                    borderWidth: __DEV__ && config.debugMode ? 2 : 0,
                    borderColor: __DEV__ && config.debugMode ? "cyan" : undefined,
                }} onPress={() => handleProxyPress(bounds.selector)}/>))}
    </>);
});
exports.PylonChatWidget.displayName = "PylonChatWidget";
