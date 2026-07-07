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
 * iOS implementation - simple passthrough.
 *
 * iOS uses native hitTest for touch pass-through, so no proxy logic needed.
 *
 * State Management:
 * - State lives entirely in native layer (no React state needed for iOS)
 * - Imperative methods call native, which handles everything
 * - Events are simply forwarded to user's listener
 */
exports.PylonChatWidget = (0, react_1.forwardRef)(({ config, user, listener, style, topInset }, ref) => {
    // Internal ref - typed as any since iOS doesn't need clickElementAtSelector.
    const chatRef = (0, react_1.useRef)(null);
    // Forward ref methods - all state managed in native layer
    (0, react_1.useImperativeHandle)(ref, () => ({
        openChat: () => chatRef.current?.openChat(),
        closeChat: () => chatRef.current?.closeChat(),
        showChatBubble: () => chatRef.current?.showChatBubble(),
        hideChatBubble: () => chatRef.current?.hideChatBubble(),
        showNewMessage: (message, isHtml) => chatRef.current?.showNewMessage(message, isHtml),
        setNewIssueCustomFields: (fields) => chatRef.current?.setNewIssueCustomFields(fields),
        setTicketFormFields: (fields) => chatRef.current?.setTicketFormFields(fields),
        updateEmailHash: (emailHash) => chatRef.current?.updateEmailHash(emailHash),
        showTicketForm: (slug) => chatRef.current?.showTicketForm(slug),
        showKnowledgeBaseArticle: (articleId) => chatRef.current?.showKnowledgeBaseArticle(articleId),
    }));
    // Event handlers - forward to user's listener
    const handleChatOpened = (0, react_1.useCallback)(() => {
        listener?.onChatOpened?.();
    }, [listener]);
    const handleChatClosed = (0, react_1.useCallback)((wasOpen) => {
        listener?.onChatClosed?.(wasOpen);
    }, [listener]);
    return (<PylonChatView_1.PylonChatView ref={chatRef} style={style || react_native_1.StyleSheet.absoluteFillObject} config={config} user={user} topInset={topInset} listener={{
            ...listener,
            onChatOpened: handleChatOpened,
            onChatClosed: handleChatClosed,
        }}/>);
});
exports.PylonChatWidget.displayName = "PylonChatWidget";
