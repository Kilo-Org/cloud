// Compile every zod schema built after this point into flat validation code.
// Must stay the first import: the compiler only sees schemas constructed after
// it installs. Node and Bun only — workerd and MV3 forbid `new Function()`.
import 'zod/compile';
import { defineSetupPluginEntry } from 'openclaw/plugin-sdk/core';
import { kiloChatPlugin } from './channel.js';

export default defineSetupPluginEntry(kiloChatPlugin);
