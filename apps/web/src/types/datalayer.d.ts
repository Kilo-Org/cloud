// Extend the Window interface to include dataLayer
declare global {
  interface Window {
    datalayer: object[];
  }
}
