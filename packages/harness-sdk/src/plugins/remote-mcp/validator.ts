import type {
  JsonSchemaValidator,
  jsonSchemaValidator,
} from '@modelcontextprotocol/sdk/validation/types.js';
/**
 * The library's own validator, answering yes.
 *
 * Ajv compiles a schema with `new Function`, which Hermes forbids, and a tool
 * result reaches the model without its output schema being read here. So the
 * validator hands the value back untouched; the passthrough is `identity`.
 */
const permissiveJsonSchemaValidator: jsonSchemaValidator = {
  getValidator<T>(): JsonSchemaValidator<T> {
    return (input: unknown) => ({
      data: input as T,
      errorMessage: undefined,
      valid: true,
    });
  },
};

export { permissiveJsonSchemaValidator };
