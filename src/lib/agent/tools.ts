// The agent's tools, and the policy for which calls need the user's approval.
//
// Odysseus gates tools through ToolPolicy / tool_capabilities / tool_approvals;
// this keeps the idea at the size of this toolset:
//   - read-only workspace tools and web lookups run automatically
//   - anything that changes the machine (write_file, run_command) always asks
//   - taint gate: once workspace files have been read into the conversation,
//     any network call asks first — private data plus an outbound request is
//     how a prompt-injected page would exfiltrate it
//   - fetching a private / local address always asks (local services are
//     private data too)

import { cleanError, requireDesktop } from '../desktop';
import { webSearch, domainOf } from '../search';
import type { ToolRuntime } from './loop';
import type { ToolCall } from './types';

export interface ToolSpec {
  name: string;
  /** One line for the system prompt. */
  summary: string;
  example: string;
  /** Argument a bare (non-JSON) block body maps to. */
  primaryArg?: string;
  /** Touches data outside the conversation that the user may consider private. */
  readsPrivateData?: boolean;
  /** Sends something off this machine. */
  network?: boolean;
  /** Changes files or runs programs. */
  effectful?: boolean;
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'list_dir',
    summary: 'List a folder in the workspace.',
    example: '{"path": "."}',
    primaryArg: 'path',
    readsPrivateData: true,
  },
  {
    name: 'read_file',
    summary: 'Read a text file from the workspace, with line numbers (200 lines at a time).',
    example: '{"path": "src/app.ts", "start_line": 1, "end_line": 200}',
    primaryArg: 'path',
    readsPrivateData: true,
  },
  {
    name: 'search_files',
    summary: 'Search file contents in the workspace by regex; optional glob like "*.ts".',
    example: '{"pattern": "function login", "glob": "*.ts"}',
    primaryArg: 'pattern',
    readsPrivateData: true,
  },
  {
    name: 'write_file',
    summary: 'Create or overwrite a workspace file with the full new content. The user must approve.',
    example: '{"path": "notes/todo.md", "content": "- item"}',
    effectful: true,
  },
  {
    name: 'append_file',
    summary:
      'Add text to the end of a workspace file, creating it if needed. Use this to build a long document across several steps instead of rewriting it. The user must approve.',
    example: '{"path": "notes/review.md", "content": "## Section 2\\n- finding"}',
    effectful: true,
  },
  {
    name: 'run_command',
    summary: 'Run a PowerShell command in the workspace folder (60 s limit). The user must approve.',
    example: '{"command": "npm test"}',
    primaryArg: 'command',
    effectful: true,
  },
  {
    name: 'web_search',
    summary: 'Search the web; returns titles, URLs and snippets.',
    example: '{"query": "LiteRT-LM WebGPU release notes"}',
    primaryArg: 'query',
    network: true,
  },
  {
    name: 'fetch_url',
    summary: 'Fetch a web page and return its readable text.',
    example: '{"url": "https://example.com/docs"}',
    primaryArg: 'url',
    network: true,
  },
];

const SPEC = new Map(TOOL_SPECS.map((s) => [s.name, s]));

interface AgentBridge {
  listDir(rel: string): Promise<string>;
  readFile(rel: string, start?: number, end?: number): Promise<string>;
  searchFiles(pattern: string, glob?: string): Promise<string>;
  writeFile(rel: string, content: string): Promise<string>;
  appendFile(rel: string, content: string): Promise<string>;
  runCommand(command: string): Promise<{ ok: boolean; output: string }>;
  fetchUrl(url: string): Promise<string>;
}

const bridge = () => (requireDesktop() as unknown as { agent: AgentBridge }).agent;

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** Loopback, RFC 1918, link-local and bare machine names (e.g. "washim-pc"). */
export function isPrivateHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }
  // IPv6 literals only — a hostname like "fcc.gov" must not match the fc00::/7 prefix.
  if (host.includes(':')) return host === '::1' || /^(fe80|fc|fd)/.test(host);
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || a === 10 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
  }
  return !host.includes('.'); // single-label names resolve on the local network
}

/** Taint state for one conversation: has private data entered the context? */
export interface TaintState {
  privateDataRead: boolean;
}

export function createToolRuntime(taint: TaintState): ToolRuntime {
  return {
    tags: TOOL_SPECS.map((s) => s.name),
    primaryArgs: Object.fromEntries(TOOL_SPECS.map((s) => [s.name, s.primaryArg])),

    describe(call: ToolCall): string {
      const a = call.args;
      switch (call.tool) {
        case 'list_dir':
          return `List ${str(a.path) || '.'}`;
        case 'read_file': {
          const range = a.start_line || a.end_line ? ` (lines ${str(a.start_line) || '1'}–${str(a.end_line) || '…'})` : '';
          return `Read ${str(a.path)}${range}`;
        }
        case 'search_files':
          return `Search /${str(a.pattern)}/${a.glob ? ` in ${str(a.glob)}` : ''}`;
        case 'write_file':
          return `Write ${str(a.path)} (${str(a.content).length} chars)`;
        case 'append_file':
          return `Append to ${str(a.path)} (${str(a.content).length} chars)`;
        case 'run_command':
          return `Run: ${str(a.command)}`;
        case 'web_search':
          return `Search the web: ${str(a.query)}`;
        case 'fetch_url':
          return `Fetch ${str(a.url)}`;
        default:
          return call.tool;
      }
    },

    approvalReason(call: ToolCall): string | null {
      const spec = SPEC.get(call.tool);
      if (!spec) return null;
      if (call.tool === 'write_file') return 'Writes a file on your disk.';
      if (call.tool === 'append_file') return 'Adds to a file on your disk.';
      if (call.tool === 'run_command') return 'Runs a program on your computer.';
      if (call.tool === 'fetch_url' && isPrivateHost(str(call.args.url))) {
        return 'Reads from a local or private-network address.';
      }
      if (spec.network && taint.privateDataRead) {
        return 'Files from your workspace are in this conversation, and this sends a request off your machine.';
      }
      return null;
    },

    async run(call: ToolCall): Promise<{ ok: boolean; output: string }> {
      const a = call.args;
      const need = (name: string) => {
        if (!str(a[name]).trim()) {
          const spec = SPEC.get(call.tool);
          throw new Error(`${call.tool} needs "${name}". Example: ${spec?.example ?? '{}'}`);
        }
        return str(a[name]);
      };
      try {
        let output: string;
        switch (call.tool) {
          case 'list_dir':
            output = await bridge().listDir(str(a.path) || '.');
            break;
          case 'read_file':
            output = await bridge().readFile(need('path'), num(a.start_line), num(a.end_line));
            break;
          case 'search_files':
            output = await bridge().searchFiles(need('pattern'), str(a.glob) || undefined);
            break;
          case 'write_file':
            output = await bridge().writeFile(need('path'), str(a.content));
            break;
          case 'append_file':
            output = await bridge().appendFile(need('path'), need('content'));
            break;
          case 'run_command':
            return await bridge().runCommand(need('command'));
          case 'web_search': {
            const results = await webSearch(need('query'));
            output = results.length
              ? results
                  .slice(0, 8)
                  .map((r, i) => `[${i + 1}] ${r.title} — ${domainOf(r.url)}\n    ${r.url}\n    ${r.content}`)
                  .join('\n\n')
              : 'No results.';
            break;
          }
          case 'fetch_url':
            output = await bridge().fetchUrl(need('url'));
            break;
          default:
            return { ok: false, output: `Unknown tool "${call.tool}". Available: ${TOOL_SPECS.map((s) => s.name).join(', ')}.` };
        }
        if (SPEC.get(call.tool)?.readsPrivateData) taint.privateDataRead = true;
        return { ok: true, output };
      } catch (err) {
        return { ok: false, output: `Error: ${cleanError(err)}` };
      }
    },
  };
}
