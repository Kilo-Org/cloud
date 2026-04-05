'use client';

import React, { useState, useEffect } from 'react';
import type { MicrodollarUsage } from '@kilocode/db/schema';

export const CopyJsonButton: React.FC<{ rawData: MicrodollarUsage }> = ({ rawData }) => {
  const [copied, setCopied] = useState(false);

  // Reset copied state after 2 seconds
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => {
      setCopied(false);
    }, 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleCopy = () => {
    const jsonString = JSON.stringify(rawData, null, 2);

    if (typeof window !== 'undefined' && window.navigator && window.navigator.clipboard) {
      window.navigator.clipboard
        .writeText(jsonString)
        .then(() => {
          setCopied(true);
        })
        .catch(error => console.error('Failed to copy JSON: ', error));
    } else {
      // Fallback for environments where clipboard API is not available
      const textArea = document.createElement('textarea');
      textArea.value = jsonString;
      textArea.style.position = 'fixed';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      try {
        const successful = document.execCommand('copy');
        if (successful) {
          setCopied(true);
        }
      } catch (err) {
        console.error('Fallback: Could not copy JSON: ', err);
      }
      document.body.removeChild(textArea);
    }
  };

  return (
    <button
      className="flex items-center justify-center rounded border border-gray-300 bg-gray-100 px-2 py-1 text-xs transition-colors hover:bg-gray-200"
      onClick={handleCopy}
      title={copied ? 'JSON Copied!' : 'Copy as JSON for test cases'}
    >
      {copied ? (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-green-600"
        >
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      ) : (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-muted-foreground"
        >
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
      )}
      <span className="ml-1">JSON</span>
    </button>
  );
};
