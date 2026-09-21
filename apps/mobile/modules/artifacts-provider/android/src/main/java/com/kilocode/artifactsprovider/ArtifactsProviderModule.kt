package com.kilocode.artifactsprovider

import android.content.Context
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * JS bridge for the read-only [ArtifactsDocumentsProvider].
 *
 * The mirror calls `notifyArtifactsChanged()` after a sync, so the phone's file
 * browser re-queries the root instead of showing a stale one.
 */
class ArtifactsProviderModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ArtifactsProvider")

    Function("notifyArtifactsChanged") {
      context.contentResolver.notifyChange(ArtifactsDocumentsProvider.rootsUri(context), null)
    }
  }

  // `AppContext` exposes only the React context. This entry point runs from a JS
  // call, so losing it means the module cannot work at all.
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()
}
