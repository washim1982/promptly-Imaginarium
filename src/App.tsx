import { Suspense, lazy, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import Background from './components/shell/Background';
import TopNav from './components/shell/TopNav';
import Footer from './components/shell/Footer';
import Chat from './components/chat/Chat';
import SettingsPanel from './components/SettingsPanel';
import About from './routes/About';
import Privacy from './routes/Privacy';
import Planning from './routes/Planning';

const PdfTools = lazy(() => import('./routes/PdfTools'));
const SvnStudio = lazy(() => import('./routes/SvnStudio'));
const GitStudio = lazy(() => import('./routes/GitStudio'));
const FileViewer = lazy(() => import('./routes/FileViewer'));
const MsStudio = lazy(() => import('./routes/MsStudio'));

export default function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { pathname } = useLocation();
  const fullBleed = pathname.startsWith('/svn') || pathname.startsWith('/git') || pathname.startsWith('/office');

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
            {}
            <Route path="/" element={<Navigate to="/chat" replace />} />
            <Route path="/chat" element={<Chat />} />
            <Route path="/planning" element={<Planning />} />
            <Route path="/research" element={<Navigate to="/planning" replace />} />
            <Route path="/pdf" element={<PdfTools />} />
            <Route path="/svn" element={<SvnStudio />} />
            <Route path="/git" element={<GitStudio />} />
            <Route path="/files" element={<FileViewer />} />
            <Route path="/office" element={<MsStudio />} />
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
