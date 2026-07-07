package com.pylon.chatwidget

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.view.View

class DebugOverlayView(context: Context) : View(context) {
    private val paint = Paint().apply {
        style = Paint.Style.STROKE
        strokeWidth = 4f
    }

    private val fillPaint = Paint().apply {
        style = Paint.Style.FILL
    }

    private val textPaint = Paint().apply {
        textSize = 24f
        isAntiAlias = true
        setShadowLayer(2f, 0f, 0f, Color.BLACK) // Add shadow for readability
    }

    var bounds: Map<String, Rect> = emptyMap()
        set(value) {
            field = value
            invalidate() // Trigger redraw
        }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)

        bounds.forEach { (selector, rect) ->
            if (!rect.isEmpty) {
                val color = getColorForSelector(selector)

                // Update paint colors
                fillPaint.color = Color.argb(30, Color.red(color), Color.green(color), Color.blue(color))
                paint.color = color
                textPaint.color = color

                // Draw filled rectangle
                canvas.drawRect(rect, fillPaint)
                // Draw border
                canvas.drawRect(rect, paint)
                // Draw label
                canvas.drawText(
                    selector,
                    rect.left.toFloat(),
                    rect.top.toFloat() - 10f,
                    textPaint
                )
            }
        }
    }

    private fun getColorForSelector(selector: String): Int {
        // Generate consistent color from string hash
        val hash = selector.hashCode()

        // Use HSV to ensure colors are vibrant and distinct
        val hue = (hash and 0xFFFF) % 360f // 0-359 degrees
        val saturation = 0.7f + ((hash shr 16) and 0xFF) / 255f * 0.3f // 0.7-1.0
        val value = 0.8f + ((hash shr 24) and 0xFF) / 255f * 0.2f // 0.8-1.0

        return Color.HSVToColor(floatArrayOf(hue, saturation, value))
    }

    init {
        setWillNotDraw(false) // Enable drawing
        isClickable = false
        isFocusable = false
    }
}