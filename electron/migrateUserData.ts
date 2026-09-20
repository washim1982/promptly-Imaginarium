// The app used to be called "Imaginarium", and Electron derives the per-user
// data folder from the product name. Without this, renaming it to OMNI-STUDIO
// would hide the model library, the chat history, SVN settings and the
// encrypted Google/Auth0 tokens behind a folder nobody looks in.
//
// The move happens once, before anything reads or writes the folder, and only
// when the new one doesn't exist yet (or is empty).

import { app } from 'electron';
import { existsSync, readdirSync, renameSync, rmdirSync, statSync } from 'node:fs';
import path from 'node:path';

export const LEGACY_APP_NAME = 'Imaginarium';

export interface MigrationResult {
  moved: boolean;
  /** Why nothing was moved, for the log. */
  reason?: 'custom-location' | 'no-legacy-folder' | 'already-populated' | 'failed';
  from?: string;
  to?: string;
  error?: string;
}

export function migrateLegacyUserData(): MigrationResult {
  const userData = app.getPath('userData');
  // A --user-data-dir override (tests, portable runs) is left alone.
  if (path.basename(userData).toLowerCase() !== app.getName().toLowerCase()) {
    return { moved: false, reason: 'custom-location' };
  }
  const legacy = path.join(path.dirname(userData), LEGACY_APP_NAME);
  if (legacy === userData) return { moved: false, reason: 'no-legacy-folder' };

  try {
    if (!existsSync(legacy) || !statSync(legacy).isDirectory()) {
      return { moved: false, reason: 'no-legacy-folder' };
    }
    // Never overwrite data that already belongs to the new name.
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
