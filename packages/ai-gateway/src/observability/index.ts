export type GatewayLogContext = Record<string, unknown>;

export type GatewayLogger = {
  debug(message: string, context?: GatewayLogContext): void;
  info(message: string, context?: GatewayLogContext): void;
  warn(message: string, context?: GatewayLogContext): void;
  error(message: string, context?: GatewayLogContext): void;
};

export type GatewayTelemetry = {
  captureException(error: unknown, context?: GatewayLogContext): void;
  captureMessage(message: string, context?: GatewayLogContext): void;
};

export const noopGatewayLogger: GatewayLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export const noopGatewayTelemetry: GatewayTelemetry = {
  captureException() {},
  captureMessage() {},
};
