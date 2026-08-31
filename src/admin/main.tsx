import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '../shared/styles/base.css';
import '../shared/styles/display.css';
import '../shared/styles/admin.css';

document.title = `${__SITE_TITLE__} — Administration`;

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
