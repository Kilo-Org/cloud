import type { PylonConfig, PylonUser } from "./types";

/**
 * Pylon SDK - Singleton for managing global configuration.
 *
 * Note: This is optional - you can also pass config directly to PylonChatView.
 * This singleton is useful if you want to initialize once and reuse across multiple views.
 */
export class Pylon {
  private static instance: Pylon;
  private _config?: PylonConfig;
  private _user?: PylonUser;

  private constructor() {}

  static get shared(): Pylon {
    if (!Pylon.instance) {
      Pylon.instance = new Pylon();
    }
    return Pylon.instance;
  }

  /**
   * Initialize the Pylon SDK with configuration.
   */
  initialize(config: PylonConfig): void {
    this._config = config;
  }

  /**
   * Set the current user for the chat.
   */
  setUser(user: PylonUser): void {
    this._user = user;
  }

  /**
   * Get the current configuration.
   */
  get config(): PylonConfig | undefined {
    return this._config;
  }

  /**
   * Get the current user.
   */
  get user(): PylonUser | undefined {
    return this._user;
  }
}

export default Pylon.shared;
