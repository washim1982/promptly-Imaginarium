import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import './index.css';
import App from './App';
import { LlmProvider } from './state/LlmContext';

// HashRouter, not BrowserRouter: the renderer is served from a custom app://
// origin, and hash routing keeps navigation entirely client-side without
// depending on History API behaviour on a non-http scheme. The URL bar is
// hidden in the desktop shell anyway, so the "#/chat" form is never visible.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <LlmProvider>
        <App />
      </LlmProvider>
    </HashRouter>
  </StrictMode>,
);
