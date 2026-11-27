// `@kilocode/sts-contracts` (through `@kilocode/service-token-client` or `@kilocode/secrets-client`)
// types its audit compression helpers over `BufferSource`, a workerd runtime type. This service's
// `lib` is `esnext` with no DOM, and its tsconfig `types` list carries only this service's own
// minimal bindings, so declare the runtime type the dependency needs.
type BufferSource = ArrayBufferView | ArrayBuffer;
