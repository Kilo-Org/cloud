"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Commands = void 0;
const codegenNativeComponent_1 = __importDefault(require("react-native/Libraries/Utilities/codegenNativeComponent"));
const codegenNativeCommands_1 = __importDefault(require("react-native/Libraries/Utilities/codegenNativeCommands"));
exports.Commands = (0, codegenNativeCommands_1.default)({
    supportedCommands: [
        'openChat',
        'closeChat',
        'showChatBubble',
        'hideChatBubble',
        'showNewMessage',
        'updateEmailHash',
        'showTicketForm',
        'showKnowledgeBaseArticle',
        'clickElementAtSelector',
    ],
});
exports.default = (0, codegenNativeComponent_1.default)('RNPylonChatView');
