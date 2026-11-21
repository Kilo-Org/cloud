export class NetworkSecretConfigurationError extends Error {
  constructor() {
    super('Network secret configuration is invalid. Check the variable names and allowed domains.');
    this.name = 'NetworkSecretConfigurationError';
  }
}
