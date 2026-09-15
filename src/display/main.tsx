import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { configureUploader } from '../shared/ui/curation-api.ts';
import { getUploader } from '../shared/ui/uploader.ts';
import '../shared/styles/base.css';
import '../shared/styles/display.css';
import '../shared/styles/curation.css';

document.title = __SITE_TITLE__;

// The family's browser token, sent on every curation request. Here and never
// in the admin's entry point: both apps share an origin and its local storage,
// and an admin recording its uploads there would have this app offer Delete on
// photographs the server refuses (family-own-trash.md 6.3).
configureUploader(getUploader());

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
