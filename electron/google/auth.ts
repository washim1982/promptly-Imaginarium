
import { app, safeStorage, shell } from 'electron';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { currentUser, onUserChange } from '../auth0/auth';
import { listenForCode, pkcePair, randomToken, signInDeadline } from '../oauth/loopback';
import { form, httpFetch } from '../oauth/http';

export const SCOPES = {
  gmail: 'https://www.googleapis.com/auth/gmail.readonly',
  drive: 'https://www.googleapis.com/auth/drive.readonly',
} as const;

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

interface ClientConfig {
  clientId: string;
  clientSecret: string;
}

interface StoredAccount {
  email: string;
  refreshToken: string;
  scopes: string[];
  ownerSub?: string;
}

export interface GoogleStatus {
  configured: boolean;
  clientSource: 'env' | 'saved' | null;
  clientIdHint: string;
  connected: boolean;
  email: string;
  gmail: boolean;
  drive: boolean;
  canPersist: boolean;
  appLoggedIn: boolean;
}

const LOGIN_REQUIRED = 'Log in to OMNI-STUDIO (Auth0) before using Gmail and Google Drive.';

const clientFile = () => path.join(app.getPath('userData'), 'google-oauth-client.json');
const accountFile = () => path.join(app.getPath('userData'), 'google-account.bin');


async function loadClient(): Promise<{ client: ClientConfig; source: 'env' | 'saved' } | null> {
  const envId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const envSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (envId && envSecret) return { client: { clientId: envId, clientSecret: envSecret }, source: 'env' };
  try {
    const saved = JSON.parse(await readFile(clientFile(), 'utf8')) as Partial<ClientConfig>;
    if (saved.clientId && saved.clientSecret) {
      return { client: { clientId: saved.clientId, clientSecret: saved.clientSecret }, source: 'saved' };
    }
  } catch {
  }
  return null;
}

export function validateClient(input: { clientId?: unknown; clientSecret?: unknown }): ClientConfig {
  const clientId = String(input?.clientId ?? '').trim();
  const clientSecret = String(input?.clientSecret ?? '').trim();
  if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
    throw new Error('The client ID should end in ".apps.googleusercontent.com". Copy it from Google Cloud → Credentials.');
  }
  if (!/^[\w-]{10,}$/.test(clientSecret)) throw new Error('Paste the client secret shown next to the client ID.');
  return { clientId, clientSecret };
}

export async function saveClient(input: { clientId?: unknown; clientSecret?: unknown }): Promise<void> {
  const client = validateClient(input);
  const previous = await loadClient();
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(clientFile(), JSON.stringify(client, null, 2), 'utf8');
  if (previous?.client.clientId !== client.clientId) await forgetAccount();
}

export async function clearClient(): Promise<void> {
  await disconnect();
  await forgetAccount();
  await rm(clientFile(), { force: true });
}


let account: StoredAccount | null = null;
let accountLoaded = false;
let accessToken: { token: string; expiresAt: number } | null = null;

async function loadAccount(): Promise<StoredAccount | null> {
  if (accountLoaded) return account;
  accountLoaded = true;
  try {
    const blob = await readFile(accountFile());
    if (!safeStorage.isEncryptionAvailable()) return null;
    account = JSON.parse(safeStorage.decryptString(blob)) as StoredAccount;
  } catch {
    account = null;
  }
  return account;
}

async function storeAccount(next: StoredAccount): Promise<void> {
  account = next;
  accountLoaded = true;
  if (!safeStorage.isEncryptionAvailable()) return;
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(accountFile(), safeStorage.encryptString(JSON.stringify(next)));
}

async function forgetAccount(): Promise<void> {
  account = null;
  accountLoaded = true;
  accessToken = null;
  await rm(accountFile(), { force: true });
}

onUserChange(() => {
  accessToken = null;
});

async function activeAccount(): Promise<StoredAccount | null> {
  const user = await currentUser();
  if (!user) return null;
  const acct = await loadAccount();
  if (!acct) return null;
  if (!acct.ownerSub) {
    await storeAccount({ ...acct, ownerSub: user.sub });
    return account;
  }
  if (acct.ownerSub !== user.sub) {
    await forgetAccount();
    return null;
  }
  return acct;
}

export async function status(): Promise<GoogleStatus> {
  const loaded = await loadClient();
  const acct = await activeAccount();
  return {
    configured: Boolean(loaded),
    clientSource: loaded?.source ?? null,
    clientIdHint: loaded ? `…${loaded.client.clientId.split('.')[0].slice(-8)}` : '',
    connected: Boolean(acct),
    email: acct?.email ?? '',
    gmail: Boolean(acct?.scopes.includes(SCOPES.gmail)),
    drive: Boolean(acct?.scopes.includes(SCOPES.drive)),
    canPersist: safeStorage.isEncryptionAvailable(),
    appLoggedIn: Boolean(await currentUser()),
  };
}


let pendingSignIn: { cancel: () => void } | null = null;

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await httpFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form(body),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || json.error) {
    const err = new Error(json.error_description || json.error || `Google token request failed (HTTP ${res.status}).`);
    (err as Error & { code?: string }).code = json.error;
    throw err;
  }
  return json;
}

export async function connect(): Promise<GoogleStatus> {
  const owner = await currentUser();
  if (!owner) throw new Error(LOGIN_REQUIRED);
  const loaded = await loadClient();
  if (!loaded) throw new Error('Add your Google OAuth client ID and secret first.');
  pendingSignIn?.cancel();

  const { verifier, challenge } = pkcePair();
  const state = randomToken();
  const { server, port, code } = await listenForCode({
    expectedState: state,
    port: 0,
    path: '/',
    successMessage: 'Google account connected.',
    describeError: (error) => (error === 'access_denied' ? 'Google sign-in was cancelled.' : `Google sign-in failed (${error}).`),
  });
  const redirectUri = `http://127.0.0.1:${port}`;
  const deadline = signInDeadline(SIGN_IN_TIMEOUT_MS, 'Google sign-in');
  pendingSignIn = { cancel: deadline.cancel };

  try {
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      client_id: loaded.client.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: [SCOPES.gmail, SCOPES.drive].join(' '),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
    }).toString();
    await shell.openExternal(url.toString());

    const authCode = await Promise.race([code, deadline.promise]);
    const tokens = await tokenRequest({
      code: authCode,
      client_id: loaded.client.clientId,
      client_secret: loaded.client.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    });
    if (!tokens.refresh_token) throw new Error('Google did not return a refresh token. Remove the app from your Google account’s third-party access and connect again.');

    const granted = (tokens.scope ?? '').split(/\s+/).filter(Boolean);
    if (!granted.includes(SCOPES.gmail) && !granted.includes(SCOPES.drive)) {
      throw new Error('Neither Gmail nor Drive access was granted. Connect again and tick both boxes.');
    }
    accessToken = { token: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000 };
    const email = await fetchEmail(tokens.access_token, granted);
    if ((await currentUser())?.sub !== owner.sub) throw new Error(LOGIN_REQUIRED);
    await storeAccount({ email, refreshToken: tokens.refresh_token, scopes: granted, ownerSub: owner.sub });
    return status();
  } finally {
    deadline.clear();
    pendingSignIn = null;
    server.close();
    server.closeAllConnections?.();
  }
}

export function cancelConnect(): void {
  pendingSignIn?.cancel();
}

async function fetchEmail(token: string, scopes: string[]): Promise<string> {
  const headers = { Authorization: `Bearer ${token}` };
  if (scopes.includes(SCOPES.gmail)) {
    const res = await httpFetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers });
    if (res.ok) return ((await res.json()) as { emailAddress?: string }).emailAddress ?? '';
  }
  const res = await httpFetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', { headers });
  if (res.ok) return ((await res.json()) as { user?: { emailAddress?: string } }).user?.emailAddress ?? '';
  return '';
}

export async function disconnect(): Promise<GoogleStatus> {
  const acct = await activeAccount();
  if (acct) {
    await httpFetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ token: acct.refreshToken }),
      timeoutMs: 15_000,
      retries: 0,
    }).catch(() => {});
  }
  await forgetAccount();
  return status();
}


async function currentToken(forceRefresh = false): Promise<string> {
  if (!(await currentUser())) throw new Error(LOGIN_REQUIRED);
  const acct = await activeAccount();
  if (!acct) throw new Error('Connect a Google account first.');
  if (!forceRefresh && accessToken && accessToken.expiresAt - 60_000 > Date.now()) return accessToken.token;
  const loaded = await loadClient();
  if (!loaded) throw new Error('The Google OAuth client is not configured.');
  try {
    const tokens = await tokenRequest({
      client_id: loaded.client.clientId,
      client_secret: loaded.client.clientSecret,
      refresh_token: acct.refreshToken,
      grant_type: 'refresh_token',
    });
    accessToken = { token: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000 };
    return tokens.access_token;
  } catch (err) {
    if ((err as { code?: string }).code === 'invalid_grant') {
      await forgetAccount();
      throw new Error('Your Google sign-in has expired or was revoked. Connect the account again.');
    }
    throw err;
  }
}

export async function requireScope(scope: keyof typeof SCOPES): Promise<void> {
  if (!(await currentUser())) throw new Error(LOGIN_REQUIRED);
  const acct = await activeAccount();
  if (!acct) throw new Error('Connect a Google account first.');
  if (!acct.scopes.includes(SCOPES[scope])) {
    throw new Error(`${scope === 'gmail' ? 'Gmail' : 'Google Drive'} access wasn't granted. Disconnect and connect again, ticking that permission.`);
  }
}

export async function googleGet(url: string, as: 'json' | 'text' | 'bytes' = 'json', maxBytes = 25 * 1024 * 1024): Promise<unknown> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await currentToken(attempt > 0);
    const res = await httpFetch(url, { headers: { Authorization: `Bearer ${token}` }, timeoutMs: 60_000 });
    if (res.status === 401 && attempt === 0) continue;
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      throw new Error(body?.error?.message || `Google request failed (HTTP ${res.status}).`);
    }
    const length = Number(res.headers.get('content-length') ?? 0);
    if (length > maxBytes) throw new Error(`That file is too large (${Math.round(length / 1024 / 1024)} MB).`);
    if (as === 'json') return res.json();
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`That file is too large (${Math.round(buf.length / 1024 / 1024)} MB).`);
    return as === 'text' ? buf.toString('utf8') : buf;
  }
  throw new Error('Google rejected the sign-in. Connect the account again.');
}
