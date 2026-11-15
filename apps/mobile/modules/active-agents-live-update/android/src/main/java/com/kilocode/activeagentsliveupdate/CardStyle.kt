package com.kilocode.activeagentsliveupdate

import android.content.Context

/**
 * The one home of the card's shared drawable and palette facts.
 *
 * Both Android cards draw the same small icon and the same palette, so the
 * drawable name and the app's colours are written once: renaming the drawable,
 * or changing a colour in `apps/mobile/global.css`, has one place to land.
 */
internal object CardStyle {
  /** The app's notification drawable. */
  private const val ICON = "notification_icon"

  /** The app's primary colour by day and by night (`global.css`). */
  const val PRIMARY_DAY = "#4F5A10"
  const val PRIMARY_NIGHT = "#FFDD00"

  /** The app's destructive red, for the retry line after a failed approve. */
  const val ERROR_DAY = "#B0483A"
  const val ERROR_NIGHT = "#F28B7A"

  /** The card's small icon, or 0 when the app has no such drawable. */
  fun icon(context: Context): Int =
    context.resources.getIdentifier(ICON, "drawable", context.packageName)
}
