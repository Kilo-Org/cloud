# Do not let R8 inline API-26-only ML Kit references into the API-24 bridge.
-keep class expo.modules.kiloandroidmodel.MlKitPromptBackend { *; }
