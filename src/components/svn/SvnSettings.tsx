import { useEffect, useState, type ReactNode } from 'react';
import { svnApi } from '../../lib/svn/api';
import type { SvnSettingsPublic } from '../../lib/svn/types';
import type { ReviewModelState } from './AiAssistBox';

interface SvnSettingsProps {
  reviewModelLabel: string;
  reviewModelState: ReviewModelState;
  onClose: () => void;
  onSaved: () => void;
}

type Status = { kind: 'info' | 'ok' | 'error'; text: string } | null;

const MODEL_STATE_TEXT: Record<ReviewModelState, string> = {
  ready: 'In your library and currently loaded.',
  'will-load': 'In your library. It loads automatically the first time you run a review.',
  missing:
    'Not in your model library yet. Add gemma-4-E4B-it-web.litertlm from the Chat tab (Add another model…).',
};

export function SvnSettings({ reviewModelLabel, reviewModelState, onClose, onSaved }: SvnSettingsProps) {
  const [settings, setSettings] = useState<SvnSettingsPublic | null>(null);
  const [repoUrl, setRepoUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [workingCopyPath, setWorkingCopyPath] = useState('');
  const [svnPath, setSvnPath] = useState('');
  const [svnInfo, setSvnInfo] = useState<Status>(null);
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    svnApi
      .getSettings()
      .then((s) => {
        setSettings(s);
        setRepoUrl(s.repoUrl);
        setUsername(s.username);
        setWorkingCopyPath(s.workingCopyPath);
        setSvnPath(s.svnPath);
        void detect(s.svnPath);
      })
      .catch((err: Error) => setStatus({ kind: 'error', text: err.message }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  async function detect(path: string) {
    setSvnInfo({ kind: 'info', text: 'Looking for svn…' });
    try {
      const { exe, version } = await svnApi.detectSvn(path);
      setSvnInfo({ kind: 'ok', text: `Subversion ${version} — ${exe}` });
    } catch (err) {
      setSvnInfo({ kind: 'error', text: (err as Error).message });
    }
  }

  /** Save without closing, so a following checkout can report its own progress. */
  async function persist(): Promise<boolean> {
    try {
      const saved = await svnApi.saveSettings({
        repoUrl,
        username,
        password: password || undefined,
        workingCopyPath,
        svnPath,
      });
      setSettings(saved);
      setPassword('');
      return true;
    } catch (err) {
      setStatus({ kind: 'error', text: (err as Error).message });
      return false;
    }
  }

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(true);
    setStatus({ kind: 'info', text: label });
    try {
      await fn();
    } catch (err) {
      setStatus({ kind: 'error', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const handleSave = () =>
    run('Saving…', async () => {
      if (await persist()) {
        setStatus({ kind: 'ok', text: 'Settings saved.' });
        onSaved();
      }
    });

  const handleCheckout = () =>
    run('Checking out the repository — this can take a while for a large repo…', async () => {
      if (!(await persist())) return;
      await svnApi.checkoutRepository();
      setStatus({ kind: 'ok', text: 'Checkout complete.' });
      onSaved();
    });

  const handleRelink = () =>
    run('Checking the folder…', async () => {
      if (!(await persist())) return;
      const saved = await svnApi.relinkWorkingCopy(workingCopyPath);
      setSettings(saved);
      setStatus({ kind: 'ok', text: 'Working copy linked.' });
      onSaved();
    });

  async function browseFolder() {
    const picked = await svnApi.browseFolder('Choose the local working-copy folder');
    if (picked) setWorkingCopyPath(picked);
  }

  async function browseSvn() {
    const picked = await svnApi.browseSvnExe();
    if (picked) {
      setSvnPath(picked);
      void detect(picked);
    }
  }

  return (
    <div className="svn-modal-overlay" onClick={busy ? undefined : onClose}>
      <div className="svn-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="SVN settings">
        <h2>SVN Settings</h2>

        <div className="svn-settings-title">▣ Repository</div>
        <Field label="Repository URL">
          <input
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://svn.example.com/repo/trunk"
            spellCheck={false}
          />
        </Field>
        <Field label="Username">
          <input value={username} onChange={(e) => setUsername(e.target.value)} spellCheck={false} />
        </Field>
        <Field
          label="Password"
          hint="Encrypted with Windows DPAPI for your user account. Leave blank to keep the saved one."
        >
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={settings?.hasPassword ? '•••••••• (unchanged)' : ''}
          />
        </Field>
        <Field label="Local working-copy folder">
          <div className="svn-field__row">
            <input
              value={workingCopyPath}
              onChange={(e) => setWorkingCopyPath(e.target.value)}
              placeholder="C:\svn\my-project"
              spellCheck={false}
            />
            <button className="svn-btn" onClick={browseFolder} type="button">
              Browse…
            </button>
          </div>
        </Field>

        <div className="svn-settings-title">⌘ Subversion client</div>
        <Field label="svn.exe">
          <div className="svn-field__row">
            <input
              value={svnPath}
              onChange={(e) => setSvnPath(e.target.value)}
              onBlur={() => void detect(svnPath)}
              placeholder="Auto-detect (PATH, VisualSVN, TortoiseSVN, SlikSVN)"
              spellCheck={false}
            />
            <button className="svn-btn" onClick={browseSvn} type="button">
              Browse…
            </button>
          </div>
          {svnInfo && (
            <div
              className={`svn-field__hint ${
                svnInfo.kind === 'error' ? 'svn-status-line--error' : svnInfo.kind === 'ok' ? 'svn-status-line--ok' : ''
              }`}
            >
              {svnInfo.text}
            </div>
          )}
        </Field>

        <div className="svn-settings-title">✦ AI review</div>
        <div className="svn-note">
          Reviews run on-device with <strong style={{ color: 'var(--svn-text)' }}>{reviewModelLabel}</strong> — no
          server, and nothing leaves this machine. {MODEL_STATE_TEXT[reviewModelState]}
        </div>

        {status && (
          <div
            className={`svn-status-line ${
              status.kind === 'error' ? 'svn-status-line--error' : status.kind === 'ok' ? 'svn-status-line--ok' : ''
            }`}
          >
            {status.text}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 20, flexWrap: 'wrap' }}>
          <button className="svn-btn-primary" onClick={handleSave} disabled={busy || !workingCopyPath}>
            Save
          </button>
          <button
            className="svn-btn"
            onClick={handleCheckout}
            disabled={busy || !repoUrl || !workingCopyPath}
            title="svn checkout into the folder above"
          >
            Checkout repository
          </button>
          <button
            className="svn-btn"
            onClick={handleRelink}
            disabled={busy || !workingCopyPath}
            title="Use a folder that is already an SVN checkout"
          >
            Link existing working copy
          </button>
          <button className="svn-btn" onClick={onClose} disabled={busy} style={{ marginLeft: 'auto' }}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="svn-field">
      <label>{label}</label>
      {children}
      {hint && <div className="svn-field__hint">{hint}</div>}
    </div>
  );
}
