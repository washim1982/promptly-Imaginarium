import path from 'node:path';

export function assertSafeRelativePath(workingCopyPath: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const resolvedRoot = path.resolve(workingCopyPath);
  const resolvedTarget = path.resolve(resolvedRoot, normalized);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    throw new Error('Path escapes the working copy root');
  }
  return normalized;
}
