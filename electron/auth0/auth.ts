// Optional app login with Auth0 (a "Native" application). Logging in is not
// needed to use Imaginarium, but it is required before a Google account can be
// connected for the chat sidebar's Email and Drive sections — and the
// connected Google account belongs to the Auth0 user who connected it.
//
// Authorization Code + PKCE through the user's browser, redirecting back to a
// fixed loopback URL that must be listed in the Auth0 application's "Allowed
// Callback URLs" (Auth0 matches callback URLs exactly, port included). Native
// apps are public clients: there is no client secret, and none is stored.
//
// The ID token arrives straight from the token endpoint over TLS, so it is
// checked for issuer, audience, expiry and nonce (OIDC Core §3.1.3.7) rather
// than signature. The refresh token is encrypted with safeStorage (Windows
// DPAPI); the renderer only ever sees the profile.

import { app, safeStorage, shell } from 'electron';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { listenForCode, pkcePair, randomToken, signInDeadline } from '../oauth/loopback';
import { form, httpFetch } from '../oauth/http';

export const CALLBACK_PORT = 47823;
export const CALLBACK_PATH = '/callback';
export const CALLBACK_URL = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPE = 'openid profile email offline_access';
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

export interface Auth0Client {
  domain: string;
  clientId: string;
}

export interface Auth0User {
  sub: string;
  name: string;
  email: string;
  emailVerified: boolean;
}

export interface Auth0Status {
  configured: boolean;
  clientSource: 'env' | 'saved' | null;
  domain: string;
  callbackUrl: string;
  loggedIn: boolean;
  user: Auth0User | null;
  canPersist: boolean;
}

interface Session {
  user: Auth0User;
  refreshToken: string | null;
}

const clientFile = () => path.join(app.getPath('userData'), 'auth0-client.json');
const sessionFile = () => path.join(app.getPath('userData'), 'auth0-session.bin');

// ---- configuration -----------------------------------------------------------------

/** "https://Tenant.us.auth0.com/" → "tenant.us.auth0.com". */
export function normalizeDomain(raw: unknown): string {
  const domain = String(raw ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    throw new Error('Enter the Auth0 domain, e.g. your-tenant.us.auth0.com (Applications → your app → Settings → Domain).');
  }
  return domain;
}

export function validateClient(input: { domain?: unknown; clientId?: unknown }): Auth0Client {
  const domain = normalizeDomain(input?.domain);
  const clientId = String(input?.clientId ?? '').trim();
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(clientId)) throw new Error('Paste the Client ID shown under Settings → Basic Information.');
  return { domain, clientId };
}

async function loadClient(): Promise<{ client: Auth0Client; source: 'env' | 'saved' } | null> {
  if (process.env.AUTH0_DOMAIN?.trim() && process.env.AUTH0_CLIENT_ID?.trim()) {
    try {
      return { client: validateClient({ domain: process.env.AUTH0_DOMAIN, clientId: process.env.AUTH0_CLIENT_ID }), source: 'env' };
    } catch {
      /* fall through to saved settings */
    }
  }
  try {
    const saved = JSON.parse(await readFile(clientFile(), 'utf8')) as Partial<Auth0Client>;
    return { client: validateClient(saved), source: 'saved' };
  } catch {
    return null;
  }
}

export async function saveClient(input: { domain?: unknown; clientId?: unknown }): Promise<void> {
  const client = validateClient(input);
  const previous = await loadClient();
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(clientFile(), JSON.stringify(client, null, 2), 'utf8');
  // A session from another tenant/application doesn't carry over.
  if (previous && (previous.client.domain !== client.domain || previous.client.clientId !== client.clientId)) await forgetSession();
}

export async function clearClient(): Promise<void> {
  await logout();
  await rm(clientFile(), { force: true });
}

// ---- session -------------------------------------------------------------------------

let session: Session | null = null;
let sessionLoaded = false;
let verified = false;
const listeners = new Set<() => void>();

/** Called when the logged-in user changes (login, logout, expiry). */
export function onUserChange(fn: () => void): void {
  listeners.add(fn);
}
const notify = () => listeners.forEach((fn) => fn());

async function loadSession(): Promise<Session | null> {
  if (sessionLoaded) return session;
  sessionLoaded = true;
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    session = JSON.parse(safeStorage.decryptString(await readFile(sessionFile()))) as Session;
  } catch {
    session = null;
  }
  return session;
}

async function storeSession(next: Session): Promise<void> {
  session = next;
  sessionLoaded = true;
  if (!safeStorage.isEncryptionAvailable()) return; // this run only; never plain text on disk
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(sessionFile(), safeStorage.encryptString(JSON.stringify(next)));
}

async function forgetSession(): Promise<void> {
  const had = Boolean(session);
  session = null;
  sessionLoaded = true;
  verified = false;
  await rm(sessionFile(), { force: true });
  if (had) notify();
}

/** The logged-in Auth0 user, or null. Used by the Google module as its gate. */
export async function currentUser(): Promise<Auth0User | null> {
  return (await loadSession())?.user ?? null;
}

export async function status(): Promise<Auth0Status> {
  const loaded = await loadClient();
  const s = await loadSession();
  return {
    configured: Boolean(loaded),
    clientSource: loaded?.source ?? null,
    domain: loaded?.client.domain ?? '',
    callbackUrl: CALLBACK_URL,
    loggedIn: Boolean(s),
    user: s?.user ?? null,
    canPersist: safeStorage.isEncryptionAvailable(),
  };
}

// ---- tokens --------------------------------------------------------------------------

interface TokenResponse {
  access_token?: string;
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function tokenRequest(domain: string, body: Record<string, string>): Promise<TokenResponse> {
  const res = await httpFetch(`https://${domain}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form(body),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || json.error) {
    const err = new Error(json.error_description || json.error || `Auth0 token request failed (HTTP ${res.status}).`);
    (err as Error & { code?: string }).code = json.error;
    throw err;
  }
  return json;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split('.')[1];
  if (!part) throw new Error('Auth0 returned a malformed ID token.');
  return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as Record<string, unknown>;
}

/** OIDC claim checks for an ID token received directly from the token endpoint. */
export function verifyIdToken(idToken: string, client: Auth0Client, nonce: string | null, now = Date.now()): Auth0User {
  const c = decodeJwtPayload(idToken);
  if (c.iss !== `https://${client.domain}/`) throw new Error('Auth0 ID token has the wrong issuer.');
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(client.clientId)) throw new Error('Auth0 ID token was issued for a different application.');
  if (typeof c.exp !== 'number' || c.exp * 1000 < now - 60_000) throw new Error('Auth0 ID token has expired.');
  if (nonce !== null && c.nonce !== nonce) throw new Error('Auth0 ID token nonce mismatch.');
  if (typeof c.sub !== 'string' || !c.sub) throw new Error('Auth0 ID token has no subject.');
  return {
    sub: c.sub,
    name: String(c.name ?? c.nickname ?? c.email ?? ''),
    email: String(c.email ?? ''),
    emailVerified: c.email_verified === true,
  };
}

// ---- login / logout ------------------------------------------------------------------

let pendingLogin: { cancel: () => void } | null = null;

export async function login(): Promise<Auth0Status> {
  const loaded = await loadClient();
  if (!loaded) throw new Error('Add your Auth0 domain and client ID first.');
  const { client } = loaded;
  pendingLogin?.cancel();

  const { verifier, challenge } = pkcePair();
  const state = randomToken();
  const nonce = randomToken();
  const { server, code } = await listenForCode({
    expectedState: state,
    port: CALLBACK_PORT,
    path: CALLBACK_PATH,
    successMessage: 'Logged in to Imaginarium.',
    describeError: (error, description) =>
      error === 'access_denied' && !description
        ? 'Login was cancelled.'
        : /callback url mismatch/i.test(description)
          ? `Auth0 rejected the callback URL. Add ${CALLBACK_URL} to Allowed Callback URLs.`
          : `Login failed: ${description || error}`,
  });
  const deadline = signInDeadline(SIGN_IN_TIMEOUT_MS, 'Login');
  pendingLogin = { cancel: deadline.cancel };

  try {
    const url = new URL(`https://${client.domain}/authorize`);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: client.clientId,
      redirect_uri: CALLBACK_URL,
      scope: SCOPE,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    }).toString();
    await shell.openExternal(url.toString());

    const authCode = await Promise.race([code, deadline.promise]);
    const tokens = await tokenRequest(client.domain, {
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code: authCode,
      redirect_uri: CALLBACK_URL,
      code_verifier: verifier,
    });
    if (!tokens.id_token) throw new Error('Auth0 did not return an ID token. Check that the application uses OIDC (scope "openid").');
    const user = verifyIdToken(tokens.id_token, client, nonce);
    const previous = await currentUser();
    await storeSession({ user, refreshToken: tokens.refresh_token ?? null });
    verified = true;
    if (previous?.sub !== user.sub) notify();
    return status();
  } finally {
    deadline.clear();
    pendingLogin = null;
    server.close();
    server.closeAllConnections?.();
  }
}

export function cancelLogin(): void {
  pendingLogin?.cancel();
}

export async function logout(): Promise<Auth0Status> {
  const s = await loadSession();
  const loaded = await loadClient();
  if (s?.refreshToken && loaded) {
    // Revoke the refresh token so a copy of it is useless. Native apps are
    // public clients, so client_id alone authenticates the request.
    await httpFetch(`https://${loaded.client.domain}/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: loaded.client.clientId, token: s.refreshToken }),
      timeoutMs: 15_000,
      retries: 0,
    }).catch(() => {});
  }
  await forgetSession();
  return status();
}

/**
 * Confirm the stored session is still valid (once per run): refresh it, which
 * also rotates the refresh token when rotation is on. A revoked or expired
 * grant logs out; being offline does not.
 */
export async function verifySession(): Promise<Auth0Status> {
  const s = await loadSession();
  const loaded = await loadClient();
  if (!s || !loaded || verified || !s.refreshToken) return status();
  try {
    const tokens = await tokenRequest(loaded.client.domain, {
      grant_type: 'refresh_token',
      client_id: loaded.client.clientId,
      refresh_token: s.refreshToken,
    });
    const user = tokens.id_token ? verifyIdToken(tokens.id_token, loaded.client, null) : s.user;
    if (user.sub !== s.user.sub) throw Object.assign(new Error('Different user'), { code: 'invalid_grant' });
    await storeSession({ user, refreshToken: tokens.refresh_token ?? s.refreshToken });
    verified = true;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'invalid_grant' || code === 'unauthorized_client') await forgetSession();
    // Network trouble: keep the session and try again next time.
  }
  return status();
}
