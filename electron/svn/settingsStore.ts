
import { app, safeStorage } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SvnSettings, SvnSettingsPublic } from './types';

interface StoredFile {
  repoUrl: string;
  username: string;
  workingCopyPath: string;
  svnPath?: string;
  passwordEnc?: string;
}

const settingsFile = () => path.join(app.getPath('userData'), 'svn-settings.json');

function encrypt(plain: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-level encryption is unavailable, so the SVN password cannot be stored safely.');
  }
  return safeStorage.encryptString(plain).toString('base64');
}

function decrypt(payload: string): string {
  try {
    return safeStorage.decryptString(Buffer.from(payload, 'base64'));
  } catch {
    return '';
  }
}

export async function loadSettings(): Promise<SvnSettings | null> {
  try {
    const stored: StoredFile = JSON.parse(await readFile(settingsFile(), 'utf8'));
    return {
      repoUrl: stored.repoUrl ?? '',
      username: stored.username ?? '',
      workingCopyPath: stored.workingCopyPath ?? '',
      svnPath: stored.svnPath ?? '',
      password: stored.passwordEnc ? decrypt(stored.passwordEnc) : '',
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function saveSettings(settings: SvnSettings): Promise<void> {
  const stored: StoredFile = {
    repoUrl: settings.repoUrl,
    username: settings.username,
    workingCopyPath: settings.workingCopyPath,
    svnPath: settings.svnPath,
    passwordEnc: settings.password ? encrypt(settings.password) : undefined,
  };
  await mkdir(path.dirname(settingsFile()), { recursive: true });
  await writeFile(settingsFile(), JSON.stringify(stored, null, 2), 'utf8');
}

export function toPublic(settings: SvnSettings | null): SvnSettingsPublic {
  return {
    repoUrl: settings?.repoUrl ?? '',
    username: settings?.username ?? '',
    workingCopyPath: settings?.workingCopyPath ?? '',
    svnPath: settings?.svnPath ?? '',
    hasPassword: Boolean(settings?.password),
  };
}

export async function loadOrDefault(): Promise<SvnSettings> {
  return (
    (await loadSettings()) ?? {
      repoUrl: '',
      username: '',
      password: '',
      workingCopyPath: '',
      svnPath: '',
    }
  );
}
