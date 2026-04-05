'use client';

import React from 'react';

interface YouTubeEmbedProps {
  videoId: string;
  width?: number | string;
  height?: number | string;
  className?: string;
  title?: string;
  autoplay?: boolean;
}

/**
 * YouTubeEmbed component that embeds a YouTube video without showing related videos
 *
 * @param videoId - YouTube video ID
 * @param width - Width of the iframe (default: 100%)
 * @param height - Height of the iframe (default: aspect ratio 16:9)
 * @param className - Additional CSS classes
 * @param title - Accessibility title for the iframe
 * @param autoplay - Whether to autoplay the video (default: false)
 */
export function YouTubeEmbed({
  videoId,
  width = '100%',
  height = 'auto',
  className = '',
  title = 'YouTube video player',
  autoplay = false,
}: YouTubeEmbedProps) {
  // Parameters to prevent related videos and customize the player
  const embedParams = new URLSearchParams({
    rel: '0', // Prevents related videos from showing
    modestbranding: '1', // Reduces YouTube branding
    showinfo: '0', // Hides video title and uploader info
    iv_load_policy: '3', // Hides video annotations
  });

  if (autoplay) {
    embedParams.append('autoplay', '1');
    embedParams.append('mute', '1'); // Required for autoplay in most browsers
  }

  const embedUrl = `https://www.youtube.com/embed/${videoId}?${embedParams.toString()}`;

  return (
    <div
      className={`relative ${className}`}
      style={{ paddingBottom: height === 'auto' ? '56.25%' : undefined }}
    >
      <iframe
        src={embedUrl}
        width={width}
        height={height === 'auto' ? '100%' : height}
        style={{
          position: height === 'auto' ? 'absolute' : 'relative',
          top: 0,
          left: 0,
          width: '100%',
          height: height === 'auto' ? '100%' : undefined,
          border: 'none',
        }}
        title={title}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
      />
    </div>
  );
}
