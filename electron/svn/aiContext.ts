// Builds the text the model sees for an AI review, ported from SVN Studio's
// web/server/src/services/aiContext.ts. It still runs in the main process (it
// needs the filesystem and svn diff), but it now only *assembles* the context —
// the model runs in the renderer on the in-app LiteRT-LM engine.

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import * as svnService from './svnService';
import type { AiContext, AiScope, SvnSettings } from './types';

const SKIP_DIRS = new Set([
  '.svn', '.git', 'node_modules', 'bin', 'obj', 'dist', 'build', '.vs', '.idea', '__pycache__',
]);
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.pdf', '.zip', '.gz', '.7z', '.rar', '.tar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.gguf', '.litertlm', '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp3', '.mp4', '.mov', '.avi', '.wav', '.class', '.jar', '.pyc', '.db', '.sqlite', '.docx', '.xlsx', '.pptx',
]);
const MAX_FILE_BYTES = 200_000;

// A NUL character marks binary content. The original embedded a raw NUL byte in
// its string literal; building it keeps an invisible control character out of
// the source.
const NUL = String.fromCharCode(0);

function isProbablyText(relativePath: string, content: string): boolean {
  return !BINARY_EXT.has(path.extname(relativePath).toLowerCase()) && !content.includes(NUL);
}

/**
 * Assemble review context in priority order — explicit files first, then
 * uncommitted changes, then folder contents — stopping once the character budget
 * is spent so the prompt always fits the model's context window.
 */
export async function buildAiContext(
  settings: SvnSettings,
  scope: AiScope,
  budget: number,
): Promise<AiContext> {
  const blocks: string[] = [];
  const seen = new Set<string>();
  let used = 0;
  let truncated = false;
  let fileCount = 0;

  // Returns false once the budget is exhausted, so callers can stop walking.
  function add(block: string): boolean {
    const remaining = budget - used;
    if (block.length <= remaining) {
      blocks.push(block);
      used += block.length;
      return true;
    }
    truncated = true;
    if (remaining > 300) {
      blocks.push(block.slice(0, remaining) + "\n[... truncated to fit the model's context ...]\n");
      used = budget;
    }
    return false;
  }

  async function addFile(relativePath: string, withDiff: boolean): Promise<boolean> {
    if (seen.has(relativePath)) return true;
    seen.add(relativePath);
    const absPath = path.join(settings.workingCopyPath, relativePath);
    const st = await stat(absPath).catch(() => null);
    if (!st?.isFile() || st.size > MAX_FILE_BYTES) return true;
    const content = await readFile(absPath, 'utf8').catch(() => '');
    if (!content || !isProbablyText(relativePath, content)) return true;
    fileCount++;
    if (!add(`File: ${relativePath}\n\`\`\`\n${content}\n\`\`\`\n\n`)) return false;
    if (withDiff) {
      const diff = await svnService.getDiff(settings, relativePath).catch(() => '');
      if (diff.trim() && !add(`Uncommitted local changes to ${relativePath}:\n\`\`\`diff\n${diff}\n\`\`\`\n\n`)) {
        return false;
      }
    }
    return true;
  }

  async function walkFolder(relativeDir: string): Promise<boolean> {
    const absDir = path.join(settings.workingCopyPath, relativeDir);
    const entries = await readdir(absDir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (!(await walkFolder(rel))) return false;
      } else if (entry.isFile()) {
        if (!(await addFile(rel, false))) return false;
      }
    }
    return true;
  }

  let keepGoing = true;
  for (const file of scope.files) {
    if (!keepGoing) break;
    keepGoing = await addFile(file, true);
  }
  if (keepGoing && scope.changes.length > 0) {
    const diff = await svnService.getReviewDiff(settings, scope.changes);
    if (diff.trim()) keepGoing = add(`Uncommitted changes (svn diff):\n\`\`\`diff\n${diff}\n\`\`\`\n\n`);
  }
  for (const folder of scope.folders) {
    if (!keepGoing) break;
    keepGoing = await walkFolder(folder);
  }

  return { context: blocks.join(''), truncated, fileCount };
}
