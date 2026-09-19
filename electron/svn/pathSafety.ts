import path from 'node:path';

/**
 * Resolve a renderer-supplied relative path against the working copy root and
 * throw if it would escape that root (blocks "../" traversal). Ported unchanged
 * from SVN Studio — every path-taking IPC handler goes through this.
 */
export function assertSafeRelativePath(workingCopyPath: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const resolvedRoot = path.resolve(workingCopyPath);
  const resolvedTarget = path.resolve(resolvedRoot, normalized);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    throw new Error('Path escapes the working copy root');
  }
  return normalized;
}
