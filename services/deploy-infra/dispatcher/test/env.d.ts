type TestEnv = {
  DEPLOY_KV: KVNamespace;
  DISPATCH: DispatchNamespace;
};

declare module 'cloudflare:test' {
  interface ProvidedEnv extends TestEnv {}
}
