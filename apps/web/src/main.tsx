import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@poker/tokens/dist/tokens.css';
import './styles.css';
import { App } from './App';
import { applyPrefs, loadPrefs } from './prefs';

// Before first paint, so the table never flashes the default theme.
applyPrefs(loadPrefs());

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
