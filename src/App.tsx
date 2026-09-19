import { Suspense, lazy, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import Background from './components/shell/Background';
import TopNav from './components/shell/TopNav';
import Footer from './components/shell/Footer';
import Chat from './components/chat/Chat';
import SettingsPanel from './components/SettingsPanel';
import About from './routes/About';
import Privacy from './routes/Privacy';
import Research from './routes/Research';

// pdf.js is heavy; only load it when the PDF Tools route is visited.
const PdfTools = lazy(() => import('./routes/PdfTools'));
// Likewise Monaco (several MB) for the SVN Studio tab.
const SvnStudio = lazy(() => import('./routes/SvnStudio'));
const GitStudio = lazy(() => import('./routes/GitStudio'));

export default function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  // SVN Studio and Git Studio are full-height workspaces; the app footer
  // would just stack a second strip under them.
  const { pathname } = useLocation();
  const fullBleed = pathname.startsWith('/svn') || pathname.startsWith('/git');

  return (
    <div className="flex h-full flex-col">
      <Background />
      <TopNav onOpenSettings={() => setSettingsOpen(true)} />

      <main className="min-h-0 flex-1">
        <Suspense
          fallback={
            <div className="mono flex h-full items-center justify-center text-sm text-white/40">
              Loading…
            </div>
          }
        >
          <Routes>
            {/* The desktop app opens straight into the workspace — the web
                build's marketing landing page has no audience here. */}
            <Route path="/" element={<Navigate to="/chat" replace />} />
            <Route path="/chat" element={<Chat />} />
            <Route path="/research" element={<Research />} />
            <Route path="/pdf" element={<PdfTools />} />
            <Route path="/svn" element={<SvnStudio />} />
            <Route path="/git" element={<GitStudio />} />
            <Route path="/about" element={<About />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="*" element={<Navigate to="/chat" replace />} />
          </Routes>
        </Suspense>
      </main>

      {!fullBleed && <Footer />}

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
