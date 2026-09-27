import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import './index.css';
import App from './App';
import { LlmProvider } from './state/LlmContext';
import { PromptProvider } from './components/PromptDialog';

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
