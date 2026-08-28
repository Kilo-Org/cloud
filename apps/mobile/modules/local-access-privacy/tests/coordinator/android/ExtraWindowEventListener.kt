package com.facebook.react.interfaces

import android.view.Window

interface ExtraWindowEventListener {
  fun onExtraWindowCreate(window: Window)
  fun onExtraWindowDestroy(window: Window)
}
