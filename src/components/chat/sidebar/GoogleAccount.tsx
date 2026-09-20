// Google account gate for the Email and Drive sections: set up the OAuth
// client → connect an account → (connected) a small account strip.

import { useState, type ReactNode } from 'react';
import { ExternalLink, KeyRound, Loader2, LogOut, ShieldCheck } from 'lucide-react';
import { googleApi } from '../../../lib/google';
import { openExternal } from '../../../lib/desktop';
import { refreshGoogle, setGoogleStatus, useGoogle } from './useGoogle';
import { LoginRequired, useAuth0 } from './AppLogin';
import { panelButton, primaryButton } from './styles';

const CONSOLE_URL = 'https://console.cloud.google.com/apis/credentials';

const inputClass =
  'w-full rounded-lg border border-white/10 bg-black/25 px-2.5 py-2 text-[12px] text-white placeholder:text-white/30 focus:border-[var(--color-neon)]/50 focus:outline-none';

export { panelButton, primaryButton } from './styles';

/**
 * Renders `children` once the user is logged in (Auth0) and a Google account
 * with `need` access is connected.
 */
export function GoogleGate({ need, children }: { need: 'gmail' | 'drive'; children: ReactNode }) {
  const { status, error } = useGoogle();
  const { status: app } = useAuth0();
  const [connecting, setConnecting] = useState(false);
  const [problem, setProblem] = useState('');

  // Chat works logged out; Gmail and Drive need the app login first.
  if (!app?.loggedIn) return <LoginRequired what={need === 'gmail' ? 'Email' : 'Google Drive'} />;

  if (!status) {
    return (
      <Centered>
        {error ? <p className="text-[12px] text-red-300">{error}</p> : <Loader2 className="animate-spin text-white/40" size={18} />}
      </Centered>
    );
  }
  if (!status.configured) return <ClientSetup />;

  if (!status.connected) {
    const connect = async () => {
      setProblem('');
      setConnecting(true);
      try {
        setGoogleStatus(await googleApi.connect());
      } catch (err) {
        setProblem((err as Error).message);
      } finally {
        setConnecting(false);
      }
    };
    return (
      <div className="space-y-3 p-3">
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
          <p className="text-[13px] font-semibold text-white">Connect your Google account</p>
          <p className="mt-1 text-[11.5px] leading-relaxed text-white/50">
            Google opens in your browser. OMNI-STUDIO asks for <b className="text-white/70">read-only</b> access to Gmail and
            Drive; nothing is sent or changed, and mail stays on this PC with the local model.
          </p>
        </div>
        {connecting ? (
          <div className="space-y-2">
            <p className="flex items-center gap-2 text-[12px] text-[var(--color-teal)]">
              <Loader2 className="animate-spin" size={14} /> Waiting for Google in your browser…
            </p>
            <button className={`${panelButton} w-full`} onClick={() => void googleApi.cancelConnect()}>
              Cancel
            </button>
          </div>
        ) : (
          <button className={`${primaryButton} w-full`} onClick={() => void connect()}>
            <KeyRound size={14} /> Connect Google account
          </button>
        )}
        {problem && <p className="text-[11.5px] leading-relaxed text-red-300">{problem}</p>}
        <ChangeClient hint={status.clientIdHint} source={status.clientSource} />
      </div>
    );
  }

  if (!status[need]) {
    return (
      <div className="space-y-3 p-3">
        <p className="text-[12px] leading-relaxed text-white/60">
          {need === 'gmail' ? 'Gmail' : 'Google Drive'} access wasn’t granted when you connected{' '}
          <span className="text-white/80">{status.email}</span>. Disconnect and connect again, leaving that box ticked.
        </p>
        <AccountStrip />
      </div>
    );
  }
  return <>{children}</>;
}

/** Signed-in address + disconnect, shown at the top of a connected section. */
export function AccountStrip() {
  const { status } = useGoogle();
  const [busy, setBusy] = useState(false);
  if (!status?.connected) return null;
  return (
    <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5">
      <ShieldCheck size={13} className="shrink-0 text-emerald-400" />
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-white/70" title={status.email}>
        {status.email || 'Google account'}
      </span>
      <button
        className="rounded p-1 text-white/45 transition hover:bg-white/10 hover:text-white disabled:opacity-40"
        title="Disconnect Google account"
        aria-label="Disconnect Google account"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            setGoogleStatus(await googleApi.disconnect());
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <Loader2 className="animate-spin" size={13} /> : <LogOut size={13} />}
      </button>
    </div>
  );
}

function ClientSetup() {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setError('');
    setSaving(true);
    try {
      setGoogleStatus(await googleApi.saveClient({ clientId, clientSecret }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 p-3">
      <div>
        <p className="text-[13px] font-semibold text-white">Set up Google access</p>
        <p className="mt-1 text-[11.5px] leading-relaxed text-white/50">
          Gmail and Drive need an OAuth client from your own Google Cloud project (free, one-time).
        </p>
      </div>
      <ol className="list-decimal space-y-1 pl-4 text-[11.5px] leading-relaxed text-white/55">
        <li>Create a project and enable the Gmail API and Google Drive API.</li>
        <li>OAuth consent screen: External, add yourself as a test user.</li>
        <li>
          Credentials → Create OAuth client ID → <b className="text-white/75">Desktop app</b>.
        </li>
        <li>Paste the client ID and secret here.</li>
      </ol>
      <button className={`${panelButton} w-full`} onClick={() => openExternal(CONSOLE_URL)}>
        <ExternalLink size={13} /> Open Google Cloud Console
      </button>
      <input className={inputClass} placeholder="Client ID (…apps.googleusercontent.com)" value={clientId} onChange={(e) => setClientId(e.target.value)} />
      <input
        className={inputClass}
        placeholder="Client secret"
        type="password"
        autoComplete="off"
        value={clientSecret}
        onChange={(e) => setClientSecret(e.target.value)}
      />
      <button className={`${primaryButton} w-full`} disabled={!clientId.trim() || !clientSecret.trim() || saving} onClick={() => void save()}>
        {saving && <Loader2 className="animate-spin" size={13} />} Save
      </button>
      {error && <p className="text-[11.5px] leading-relaxed text-red-300">{error}</p>}
      <p className="text-[10.5px] leading-relaxed text-white/35">Full walkthrough: README → “Google account (Email &amp; Drive)”.</p>
    </div>
  );
}

function ChangeClient({ hint, source }: { hint: string; source: 'env' | 'saved' | null }) {
  if (source === 'env') {
    return <p className="text-[10.5px] text-white/35">OAuth client {hint} (from GOOGLE_OAUTH_CLIENT_ID).</p>;
  }
  return (
    <p className="text-[10.5px] text-white/35">
      OAuth client {hint} ·{' '}
      <button
        className="underline decoration-white/20 underline-offset-2 hover:text-white/70"
        onClick={async () => {
          await googleApi.clearClient();
          await refreshGoogle();
        }}
      >
        change
      </button>
    </p>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="grid h-40 place-items-center p-3 text-center">{children}</div>;
}
