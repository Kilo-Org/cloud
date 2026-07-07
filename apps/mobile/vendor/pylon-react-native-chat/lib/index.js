"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PylonSDK = exports.Pylon = exports.PylonChatWidget = exports.PylonChatView = void 0;
var PylonChatView_1 = require("./PylonChatView");
Object.defineProperty(exports, "PylonChatView", { enumerable: true, get: function () { return PylonChatView_1.PylonChatView; } });
// React Native will automatically resolve to .ios.tsx or .android.tsx at runtime
// TypeScript just needs to find the types from one of them
var PylonChatWidget_1 = require("./PylonChatWidget");
Object.defineProperty(exports, "PylonChatWidget", { enumerable: true, get: function () { return PylonChatWidget_1.PylonChatWidget; } });
var PylonModule_1 = require("./PylonModule");
Object.defineProperty(exports, "Pylon", { enumerable: true, get: function () { return PylonModule_1.Pylon; } });
Object.defineProperty(exports, "PylonSDK", { enumerable: true, get: function () { return __importDefault(PylonModule_1).default; } });
