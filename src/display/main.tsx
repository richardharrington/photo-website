import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '../shared/styles/base.css';
import '../shared/styles/display.css';

document.title = __SITE_TITLE__;

// The whole viewer is one long page whose scroll position is decided by the
// route, so the browser's own restore-on-back would fight the anchor scroll.
// Owning it outright keeps back and forward landing where the route says.
if ('scrollRestoration' in window.history) {
  window.history.scrollRestoration = 'manual';
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
