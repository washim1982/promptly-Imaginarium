
import { app } from 'electron';
import { existsSync, readdirSync, renameSync, rmdirSync, statSync } from 'node:fs';
import path from 'node:path';

export const LEGACY_APP_NAME = 'Imaginarium';

export interface MigrationResult {
  moved: boolean;
  reason?: 'custom-location' | 'no-legacy-folder' | 'already-populated' | 'failed';
  from?: string;
  to?: string;
  error?: string;
}

export function migrateLegacyUserData(): MigrationResult {
  const userData = app.getPath('userData');
  if (path.basename(userData).toLowerCase() !== app.getName().toLowerCase()) {
    return { moved: false, reason: 'custom-location' };
  }
  const legacy = path.join(path.dirname(userData), LEGACY_APP_NAME);
  if (legacy === userData) return { moved: false, reason: 'no-legacy-folder' };

  try {
    if (!existsSync(legacy) || !statSync(legacy).isDirectory()) {
      return { moved: false, reason: 'no-legacy-folder' };
    }
    if (existsSync(userData) && readdirSync(userData).length > 0) {
      return { moved: false, reason: 'already-populated' };
    }
    if (existsSync(userData)) rmdirSync(userData);
    renameSync(legacy, userData);
    return { moved: true, from: legacy, to: userData };
  } catch (err) {
    return { moved: false, reason: 'failed', from: legacy, to: userData, error: (err as Error).message };
  }
}
