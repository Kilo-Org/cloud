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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PylonChatView = void 0;
const react_1 = __importStar(require("react"));
const react_native_1 = require("react-native");
const RNPylonChatViewNativeComponent_1 = __importStar(require("./specs/RNPylonChatViewNativeComponent"));
const NativePylonChatCommands_1 = __importDefault(require("./NativePylonChatCommands"));
exports.PylonChatView = react_1.default.forwardRef(({ config, user, style, listener, topInset = 0 }, ref) => {
    const nativeRef = (0, react_1.useRef)(null);
    const dispatchDictionaryCommand = (commandName, args = []) => {
        if (react_native_1.Platform.OS === "ios") {
            if (!NativePylonChatCommands_1.default) {
                console.error(`[PylonChat] NativePylonChatCommands module is null`);
                return;
            }
            const fn = NativePylonChatCommands_1.default[commandName];
            if (fn) {
                fn(...args);
            }
            else {
                console.warn(`[PylonChat] RNPylonChatCommands.${commandName} not available`);
            }
        }
        else {
            const handle = (0, react_native_1.findNodeHandle)(nativeRef.current);
            if (!handle) {
                return;
            }
            react_native_1.UIManager.dispatchViewManagerCommand(handle, commandName, args);
        }
    };
    (0, react_1.useImperativeHandle)(ref, () => ({
        openChat: () => {
            if (nativeRef.current) {
                RNPylonChatViewNativeComponent_1.Commands.openChat(nativeRef.current);
            }
        },
        closeChat: () => {
            if (nativeRef.current) {
                RNPylonChatViewNativeComponent_1.Commands.closeChat(nativeRef.current);
            }
        },
        showChatBubble: () => {
            if (nativeRef.current) {
                RNPylonChatViewNativeComponent_1.Commands.showChatBubble(nativeRef.current);
            }
        },
        hideChatBubble: () => {
            if (nativeRef.current) {
                RNPylonChatViewNativeComponent_1.Commands.hideChatBubble(nativeRef.current);
            }
        },
        showNewMessage: (message, isHtml = false) => {
            if (nativeRef.current) {
                RNPylonChatViewNativeComponent_1.Commands.showNewMessage(nativeRef.current, message, isHtml);
            }
        },
        setNewIssueCustomFields: (fields) => dispatchDictionaryCommand("setNewIssueCustomFields", [fields]),
        setTicketFormFields: (fields) => dispatchDictionaryCommand("setTicketFormFields", [fields]),
        updateEmailHash: (emailHash) => {
            if (nativeRef.current) {
                RNPylonChatViewNativeComponent_1.Commands.updateEmailHash(nativeRef.current, emailHash ?? "");
            }
        },
        showTicketForm: (slug) => {
            if (nativeRef.current) {
                RNPylonChatViewNativeComponent_1.Commands.showTicketForm(nativeRef.current, slug);
            }
        },
        showKnowledgeBaseArticle: (articleId) => {
            if (nativeRef.current) {
                RNPylonChatViewNativeComponent_1.Commands.showKnowledgeBaseArticle(nativeRef.current, articleId);
            }
        },
        clickElementAtSelector: (selector) => {
            if (nativeRef.current) {
                RNPylonChatViewNativeComponent_1.Commands.clickElementAtSelector(nativeRef.current, selector);
            }
        },
    }), []);
    return (<RNPylonChatViewNativeComponent_1.default ref={nativeRef} style={style} pointerEvents="box-none" appId={config.appId} widgetBaseUrl={config.widgetBaseUrl} widgetScriptUrl={config.widgetScriptUrl} enableLogging={config.enableLogging} debugMode={config.debugMode} primaryColor={config.primaryColor} userEmail={user?.email} userName={user?.name} userAvatarUrl={user?.avatarUrl} userEmailHash={user?.emailHash} userAccountId={user?.accountId} userAccountExternalId={user?.accountExternalId} topInset={topInset} onPylonLoaded={() => listener?.onPylonLoaded?.()} onPylonInitialized={() => listener?.onPylonInitialized?.()} onPylonReady={() => listener?.onPylonReady?.()} onChatOpened={() => listener?.onChatOpened?.()} onChatClosed={(event) => listener?.onChatClosed?.(event.nativeEvent.wasOpen)} onUnreadCountChanged={(event) => listener?.onUnreadCountChanged?.(event.nativeEvent.count)} onMessageReceived={(event) => listener?.onMessageReceived?.(event.nativeEvent.message)} onPylonError={(event) => listener?.onPylonError?.(event.nativeEvent.error)} onInteractiveBoundsChanged={(event) => listener?.onInteractiveBoundsChanged?.(event.nativeEvent)}/>);
});
exports.PylonChatView.displayName = "PylonChatView";
exports.default = exports.PylonChatView;
