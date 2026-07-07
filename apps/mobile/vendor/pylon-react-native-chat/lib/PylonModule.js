"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Pylon = void 0;
/**
 * Pylon SDK - Singleton for managing global configuration.
 *
 * Note: This is optional - you can also pass config directly to PylonChatView.
 * This singleton is useful if you want to initialize once and reuse across multiple views.
 */
class Pylon {
    constructor() { }
    static get shared() {
        if (!Pylon.instance) {
            Pylon.instance = new Pylon();
        }
        return Pylon.instance;
    }
    /**
     * Initialize the Pylon SDK with configuration.
     */
    initialize(config) {
        this._config = config;
    }
    /**
     * Set the current user for the chat.
     */
    setUser(user) {
        this._user = user;
    }
    /**
     * Get the current configuration.
     */
    get config() {
        return this._config;
    }
    /**
     * Get the current user.
     */
    get user() {
        return this._user;
    }
}
exports.Pylon = Pylon;
exports.default = Pylon.shared;
