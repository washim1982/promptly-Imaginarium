// Locating and running the Subversion command-line client.
//
// SVN Studio assumed `svn` was on PATH. On Windows it frequently isn't: VisualSVN
// Server, TortoiseSVN (with command-line tools) and SlikSVN each install svn.exe
// into their own folder, and only some add it to PATH. So resolution goes:
// explicit setting → PATH → well-known install folders.

import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { CommandResult } from './types';

const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(
  (p): p is string => Boolean(p),
);

const KNOWN_LOCATIONS = programFiles.flatMap((root) => [
  path.join(root, 'VisualSVN Server', 'bin', 'svn.exe'),
  path.join(root, 'VisualSVN', 'bin', 'svn.exe'),
  path.join(root, 'TortoiseSVN', 'bin', 'svn.exe'),
  path.join(root, 'SlikSvn', 'bin', 'svn.exe'),
  path.join(root, 'Subversion', 'bin', 'svn.exe'),
  path.join(root, 'CollabNet', 'Subversion Client', 'svn.exe'),
]);

let resolved: { configured: string; exe: string } | null = null;

function exec(file: string, args: string[], cwd?: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    // Arguments are passed as an array and never through a shell, which rules
    // out injection whatever the renderer puts in paths or commit messages.
    execFile(
      file,
      args,
      { cwd, maxBuffer: 1024 * 1024 * 64, windowsHide: true },
      (error, stdout, stderr) => {
        const code = (error as NodeJS.ErrnoException & { code?: unknown })?.code ?? 0;
        // A non-numeric code (e.g. ENOENT) means the process never ran at all.
        if (error && typeof code !== 'number') {
          reject(error);
          return;
        }
        resolve({ stdout, stderr, code: typeof code === 'number' ? code : 0 });
      },
    );
  });
}

async function works(exe: string): Promise<boolean> {
  try {
    const r = await exec(exe, ['--version', '--quiet']);
    return r.code === 0;
  } catch {
    return false;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The svn executable to use. Cached per configured value, so changing the path
 * in Settings takes effect immediately without paying for detection every call.
 */
export async function resolveSvn(configured = ''): Promise<string> {
  if (resolved && resolved.configured === configured) return resolved.exe;

  const candidates: string[] = [];
  if (configured.trim()) candidates.push(configured.trim());
  candidates.push('svn'); // PATH lookup
  for (const known of KNOWN_LOCATIONS) if (await exists(known)) candidates.push(known);

  for (const exe of candidates) {
    if (await works(exe)) {
      resolved = { configured, exe };
      return exe;
    }
  }

  if (configured.trim()) {
    throw new Error(
      `The svn executable set in SVN Settings (${configured}) did not run. ` +
        'Fix the path, or clear it to auto-detect.',
    );
  }
  throw new Error(
    'Subversion command-line client (svn.exe) not found. Install one — VisualSVN, ' +
      'TortoiseSVN with "command line client tools", or SlikSVN — or set its path in SVN Settings.',
  );
}

/** Version of the svn that will be used, for the Settings panel. */
export async function detectSvn(configured = ''): Promise<{ exe: string; version: string }> {
  const exe = await resolveSvn(configured);
  const r = await exec(exe, ['--version', '--quiet']);
  return { exe, version: r.stdout.trim() };
}

export async function runSvn(
  configured: string,
  args: string[],
  cwd?: string,
): Promise<CommandResult> {
  return exec(await resolveSvn(configured), args, cwd);
}
