import type { PylonConfig, PylonUser } from "./types";
/**
 * Pylon SDK - Singleton for managing global configuration.
 *
 * Note: This is optional - you can also pass config directly to PylonChatView.
 * This singleton is useful if you want to initialize once and reuse across multiple views.
 */
export declare class Pylon {
    private static instance;
    private _config?;
    private _user?;
    private constructor();
    static get shared(): Pylon;
    /**
     * Initialize the Pylon SDK with configuration.
     */
    initialize(config: PylonConfig): void;
    /**
     * Set the current user for the chat.
     */
    setUser(user: PylonUser): void;
    /**
     * Get the current configuration.
     */
    get config(): PylonConfig | undefined;
    /**
     * Get the current user.
     */
    get user(): PylonUser | undefined;
}
declare const _default: Pylon;
export default _default;
