/**
 * FAIRPLAY · Application entry point.
 * Imports fonts via @fontsource packages (not Google CDN).
 */

// Space Grotesk weights: 400, 500, 600, 700
import '@fontsource/space-grotesk/400.css';
import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/600.css';
import '@fontsource/space-grotesk/700.css';

// JetBrains Mono weights: 400, 500, 600
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';

import './styles/theme.css';
import './styles/mobile.css';

import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
