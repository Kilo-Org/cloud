Persist the state with [local storage](https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage) so that it remains after a page refresh. This can be useful for a dark theme.
This hook is used in the same way as useState except that you must pass the storage key in the 1st parameter.

You can also pass an optional third parameter to use a custom serializer/deserializer.

**Note**: If you use this hook in an SSR context, set the `initializeWithValue` option to `false`, it will initialize in SSR with the initial value.
