export {};

declare global {
  interface Window {
    dataLayer?: Array<Record<string, unknown>>;
  }
}
