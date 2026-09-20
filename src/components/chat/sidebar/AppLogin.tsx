// Optional app login (Auth0): the account area at the bottom of the chat
// sidebar, the "log in first" card the Email / Drive sections show, and the
// Auth0 setup dialog. Logging in or out also refreshes the Google status,
// since Google access depends on who is logged in.

import { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, ExternalLink, Loader2, LogIn, LogOut, Settings2, UserRound, X } from 'lucide-react';
import { auth0Api, initialsOf, type Auth0Status } from '../../../lib/auth0';
import { openExternal } from '../../../lib/desktop';
import { refreshGoogle } from './useGoogle';
import { panelButton, primaryButton } from './styles';

// ---- shared status store ------------------------------------------------------------

let current: Auth0Status | null = null;
let loggingIn = false;
let loginError = '';
/** Which Log in button started the attempt, so its error shows once, there. */
let loginOrigin: 'account' | 'gate' = 'account';
let started = false;
const listeners = new Set<() => void>();
const publish = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

function set(next: Auth0Status) {
  const changedUser = current?.user?.sub !== next.user?.sub;
  current = next;
  publish();
  if (changedUser) void refreshGoogle();
}

export function useAuth0() {
  const status = useSyncExternalStore(subscribe, () => current);
  const busy = useSyncExternalStore(subscribe, () => loggingIn);
  const error = useSyncExternalStore(subscribe, () => loginError);
  const origin = useSyncExternalStore(subscribe, () => loginOrigin);
  useEffect(() => {
    if (started) return;
    started = true;
    // Show the stored session at once, then confirm it with Auth0 in the background.
    void auth0Api.status().then(set).then(() => auth0Api.verify().then(set)).catch(() => {});
  }, []);
  return { status, busy, error, origin };
}

export async function login(from: 'account' | 'gate' = 'account'): Promise<void> {
  loggingIn = true;
  loginError = '';
  loginOrigin = from;
  publish();
  try {
    set(await auth0Api.login());
  } catch (err) {
    loginError = (err as Error).message;
  } finally {
    loggingIn = false;
    publish();
  }
}

export async function logout(): Promise<void> {
  set(await auth0Api.logout());
}

// ---- setup dialog ---------------------------------------------------------------------

const inputClass =
  'w-full rounded-lg border border-white/10 bg-black/25 px-2.5 py-2 text-[12.5px] text-white placeholder:text-white/30 focus:border-[var(--color-neon)]/50 focus:outline-none';

export function Auth0SetupDialog({ onClose }: { onClose: () => void }) {
  const { status } = useAuth0();
  const [domain, setDomain] = useState(status?.domain ?? '');
  const [clientId, setClientId] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const callback = status?.callbackUrl ?? 'http://127.0.0.1:47823/callback';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async () => {
    setError('');
    setSaving(true);
    try {
      set(await auth0Api.saveClient({ domain, clientId }));
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/55 p-6 backdrop-blur-sm" onMouseDown={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Auth0 login setup"
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-[var(--radius-panel)] border border-white/12 bg-[#16141f]/95 shadow-2xl"
      >
        <header className="flex items-start gap-3 border-b border-white/8 px-5 py-4">
          <div className="flex-1">
            <h2 className="text-[16px] font-semibold text-white">Log in with Auth0</h2>
            <p className="mt-1 text-[12px] text-white/50">
              Optional for chatting — required to connect Gmail and Google Drive. Uses your Auth0 <b className="text-white/70">Native</b> application.
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-white/50 hover:bg-white/10 hover:text-white" aria-label="Close">
            <X size={18} />
          </button>
        </header>

        <div className="space-y-3 px-5 py-4">
          <div className="rounded-xl border border-[var(--color-teal)]/30 bg-[var(--color-teal)]/10 p-3">
            <p className="text-[12px] text-white/80">
              In Auth0 → Applications → your app → Settings, add this to <b>Allowed Callback URLs</b>:
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md bg-black/30 px-2 py-1.5 font-mono text-[12px] text-[var(--color-teal)]">{callback}</code>
              <button
                className={panelButton}
                onClick={() => {
                  void navigator.clipboard.writeText(callback).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
              >
                {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>

          <label className="block space-y-1.5">
            <span className="mono text-[10px] uppercase tracking-wider text-white/45">Domain</span>
            <input className={inputClass} placeholder="your-tenant.us.auth0.com" value={domain} onChange={(e) => setDomain(e.target.value)} />
          </label>
          <label className="block space-y-1.5">
            <span className="mono text-[10px] uppercase tracking-wider text-white/45">Client ID</span>
            <input className={inputClass} placeholder="From Settings → Basic Information" value={clientId} onChange={(e) => setClientId(e.target.value)} />
          </label>
          <p className="text-[11px] leading-relaxed text-white/40">
            No client secret is needed or stored: native apps log in with PKCE. Full steps: README → “App login (Auth0)”.
          </p>
          {error && <p className="text-[12px] leading-relaxed text-red-300">{error}</p>}
        </div>

        <footer className="flex items-center gap-2 border-t border-white/8 px-5 py-3">
          {status?.domain && (
            <button className={panelButton} onClick={() => openExternal(`https://manage.auth0.com/`)}>
              <ExternalLink size={13} /> Auth0 Dashboard
            </button>
          )}
          <span className="flex-1" />
          {status?.configured && status.clientSource === 'saved' && (
            <button
              className={panelButton}
              onClick={async () => {
                set(await auth0Api.clearClient());
                onClose();
              }}
            >
              Remove
            </button>
          )}
          <button className={primaryButton} disabled={!domain.trim() || !clientId.trim() || saving} onClick={() => void save()}>
            {saving && <Loader2 size={13} className="animate-spin" />} Save
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

// ---- sidebar account area ---------------------------------------------------------------

/** Bottom of the expanded sidebar: Log in (optional) or the logged-in user. */
export function AccountArea() {
  const { status, busy, error, origin } = useAuth0();
  const [setupOpen, setSetupOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  if (!status) return null;

  return (
    <div className="relative border-t border-white/8 p-2.5">
      {status.loggedIn && status.user ? (
        <>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            aria-expanded={menuOpen}
            className="flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition hover:bg-white/5"
          >
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--color-teal)]/20 text-[11px] font-bold text-[var(--color-teal)]">
              {initialsOf(status.user)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-semibold text-white">{status.user.name || status.user.email}</span>
              <span className="block truncate text-[10.5px] text-white/40">{status.user.email}</span>
            </span>
          </button>
          {menuOpen && (
            <div className="absolute bottom-full left-2.5 right-2.5 mb-1 rounded-xl border border-white/12 bg-[#16141f] p-1 shadow-2xl">
              <p className="px-2.5 py-1.5 text-[10.5px] text-white/35">Logged in via {status.domain}</p>
              <button
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[12.5px] text-white/75 hover:bg-white/5 hover:text-white"
                onClick={() => {
                  setMenuOpen(false);
                  setSetupOpen(true);
                }}
              >
                <Settings2 size={14} /> Auth0 settings
              </button>
              <button
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[12.5px] text-red-300/90 hover:bg-white/5"
                onClick={() => {
                  setMenuOpen(false);
                  void logout();
                }}
              >
                <LogOut size={14} /> Log out
              </button>
            </div>
          )}
        </>
      ) : busy ? (
        <div className="flex items-center gap-2 px-1">
          <Loader2 size={14} className="animate-spin text-[var(--color-teal)]" />
          <span className="flex-1 text-[12px] text-white/60">Finish logging in in your browser…</span>
          <button className="text-[11px] text-white/45 underline-offset-2 hover:underline" onClick={() => void auth0Api.cancelLogin()}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <button
            className={`${panelButton} flex-1`}
            onClick={() => (status.configured ? void login() : setSetupOpen(true))}
            title="Optional — needed to connect Gmail and Google Drive"
          >
            <LogIn size={14} /> Log in <span className="text-white/35">(optional)</span>
          </button>
          {status.configured && (
            <button
              className="rounded-lg border border-white/10 p-1.5 text-white/45 transition hover:bg-white/10 hover:text-white"
              title="Auth0 settings"
              aria-label="Auth0 settings"
              onClick={() => setSetupOpen(true)}
            >
              <Settings2 size={14} />
            </button>
          )}
        </div>
      )}
      {error && origin === 'account' && !busy && !status.loggedIn && (
        <p className="mt-1.5 px-1 text-[11px] leading-relaxed text-red-300">{error}</p>
      )}
      {setupOpen && <Auth0SetupDialog onClose={() => setSetupOpen(false)} />}
    </div>
  );
}

/** Collapsed-rail version: avatar or a log-in icon. */
export function RailAccount({ onExpand }: { onExpand: () => void }) {
  const { status } = useAuth0();
  if (!status) return null;
  return status.loggedIn && status.user ? (
    <button
      onClick={onExpand}
      title={`${status.user.name} — ${status.user.email}`}
      aria-label="Account"
      className="grid h-9 w-9 place-items-center rounded-full bg-[var(--color-teal)]/20 text-[11px] font-bold text-[var(--color-teal)]"
    >
      {initialsOf(status.user)}
    </button>
  ) : (
    <button
      onClick={onExpand}
      title="Log in (optional)"
      aria-label="Log in"
      className="grid h-10 w-10 place-items-center rounded-xl text-white/55 transition hover:bg-white/5 hover:text-white"
    >
      <UserRound size={17} />
    </button>
  );
}

/** Shown by the Email / Drive sections until the user logs in. */
export function LoginRequired({ what }: { what: string }) {
  const { status, busy, error, origin } = useAuth0();
  const [setupOpen, setSetupOpen] = useState(false);
  if (!status) {
    return (
      <div className="grid h-40 place-items-center">
        <Loader2 className="animate-spin text-white/40" size={18} />
      </div>
    );
  }
  return (
    <div className="space-y-3 p-3">
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
        <p className="text-[13px] font-semibold text-white">Log in to use {what}</p>
        <p className="mt-1 text-[11.5px] leading-relaxed text-white/50">
          Chat works without an account, but connecting Gmail and Google Drive requires logging in to OMNI-STUDIO. The Google
          account you connect is tied to your login.
        </p>
      </div>
      {busy ? (
        <div className="space-y-2">
          <p className="flex items-center gap-2 text-[12px] text-[var(--color-teal)]">
            <Loader2 className="animate-spin" size={14} /> Finish logging in in your browser…
          </p>
          <button className={`${panelButton} w-full`} onClick={() => void auth0Api.cancelLogin()}>
            Cancel
          </button>
        </div>
      ) : status.configured ? (
        <button className={`${primaryButton} w-full`} onClick={() => void login('gate')}>
          <LogIn size={14} /> Log in
        </button>
      ) : (
        <button className={`${primaryButton} w-full`} onClick={() => setSetupOpen(true)}>
          <Settings2 size={14} /> Set up Auth0 login
        </button>
      )}
      {error && origin === 'gate' && !busy && <p className="text-[11.5px] leading-relaxed text-red-300">{error}</p>}
      {setupOpen && <Auth0SetupDialog onClose={() => setSetupOpen(false)} />}
    </div>
  );
}
