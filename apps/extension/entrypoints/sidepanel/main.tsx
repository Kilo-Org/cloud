import './style.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';

const root = document.querySelector('#root');

if (!(root instanceof HTMLElement)) {
  throw new Error('Side panel root element was not found.');
}

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
