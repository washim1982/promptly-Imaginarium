import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import './index.css';
import App from './App';
import { LlmProvider } from './state/LlmContext';
import { PromptProvider } from './components/PromptDialog';
import { applyAppearance, readAppearance } from './lib/themes';

// Before the first render, so a light-mode user doesn't see a dark flash.
// This can't be an inline script in index.html: the CSP has no 'unsafe-inline'.
applyAppearance(readAppearance());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <LlmProvider>
        <PromptProvider>
          <App />
        </PromptProvider>
      </LlmProvider>
    </HashRouter>
  </StrictMode>,
);
