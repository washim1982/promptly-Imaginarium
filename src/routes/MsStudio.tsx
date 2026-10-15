// MS-Studio — documents, spreadsheets and decks from one folder.
//
// Left: the folder tree, documents only. Right: the file in its own shape — a
// grid for spreadsheets, a page for Word, slides for PowerPoint.
//
// Only spreadsheets are editable, and that is a deliberate limit rather than
// an unfinished one: ExcelJS can change cells inside the original workbook and
// write it back without losing what it didn't touch. There is no equivalent
// for .docx or .pptx that round-trips honestly, so those are shown, labelled
// read-only, and left alone.

import { useCallback, useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FilePlus2,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  Presentation,
  RefreshCw,
  X,
} from 'lucide-react';
import AssistantPanel from '../components/office/AssistantPanel';
import SheetEditor from '../components/office/SheetEditor';
import SlideViewer from '../components/office/SlideViewer';
import WordViewer from '../components/office/WordViewer';
import { officeApi, type DocKind, type OfficeWorkspace, type TreeNode } from '../lib/office/api';
import { cleanError } from '../lib/desktop';
import { usePrompt } from '../components/PromptDialog';
import '../components/office/ms-studio.css';

const ICON: Record<DocKind, typeof FileText> = {
  sheet: FileSpreadsheet,
  word: FileText,
  slides: Presentation,
  other: FileText,
};

const KIND_LABEL: Record<DocKind, string> = {
  sheet: 'Spreadsheet',
  word: 'Document',
  slides: 'Presentation',
  other: 'File',
};

export default function MsStudio() {
  const ask = usePrompt();
  const [workspace, setWorkspace] = useState<OfficeWorkspace | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [activeFile, setActiveFile] = useState<TreeNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [assistant, setAssistant] = useState(true);

  const notify = useCallback((type: 'success' | 'error', message: string) => setToast({ type, message }), []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), toast.type === 'error' ? 7000 : 3500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const refresh = useCallback(async () => {
    try {
      setTree(await officeApi.tree());
    } catch (err) {
      notify('error', cleanError(err));
    }
  }, [notify]);

  useEffect(() => {
    void (async () => {
      try {
        const ws = await officeApi.getWorkspace();
        setWorkspace(ws);
        if (ws) setTree(await officeApi.tree());
      } catch {
        /* no folder chosen yet */
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const pickFolder = async () => {
    try {
      const ws = await officeApi.pickWorkspace();
      setWorkspace(ws);
      setActiveFile(null);
      if (ws) setTree(await officeApi.tree());
    } catch (err) {
      notify('error', cleanError(err));
    }
  };

  const selectFile = (node: TreeNode) => {
    if (dirty && !window.confirm('You have unsaved changes. Open another file and lose them?')) return;
    setDirty(false);
    setActiveFile(node);
  };

  const createFile = async () => {
    const name = await ask({
      title: 'New document',
      label: 'File name — end it with .xlsx or .docx',
      defaultValue: 'Untitled.xlsx',
      confirmLabel: 'Create',
    });
    if (!name) return;
    const folder = activeFile?.path.includes('/') ? activeFile.path.slice(0, activeFile.path.lastIndexOf('/')) : '';
    const rel = folder ? `${folder}/${name}` : name;
    try {
      await officeApi.create(rel);
      await refresh();
      notify('success', `Created ${name}.`);
    } catch (err) {
      notify('error', cleanError(err));
    }
  };

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    if (node.isDir) {
      const isOpen = open.has(node.path);
      return (
        <div key={node.path}>
          <button
            className="ms-tree-row"
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() =>
              setOpen((s) => {
                const next = new Set(s);
                if (next.has(node.path)) next.delete(node.path);
                else next.add(node.path);
                return next;
              })
            }
          >
            {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <span className="truncate">{node.name}</span>
          </button>
          {isOpen && node.children?.map((child) => renderNode(child, depth + 1))}
        </div>
      );
    }
    const Icon = ICON[node.kind];
    return (
      <button
        key={node.path}
        className={`ms-tree-row ${activeFile?.path === node.path ? 'active' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 + 13 }}
        onClick={() => selectFile(node)}
        title={node.path}
      >
        <Icon size={13} className={`ms-icon ${node.kind}`} />
        <span className="truncate">{node.name}</span>
        {node.legacy && <span className="ms-legacy">old</span>}
      </button>
    );
  };

  return (
    <div className="ms-studio flex h-full overflow-hidden">
      <aside className="ms-sidebar">
        <div className="ms-sidebar-head">
          <button className="ms-primary" onClick={() => void pickFolder()}>
            <FolderOpen size={15} /> {workspace ? 'Change folder' : 'Choose folder'}
          </button>
          {workspace && (
            <>
              <button className="ms-icon-button" onClick={() => void createFile()} title="New document" aria-label="New document">
                <FilePlus2 size={15} />
              </button>
              <button className="ms-icon-button" onClick={() => void refresh()} title="Refresh" aria-label="Refresh">
                <RefreshCw size={14} />
              </button>
            </>
          )}
        </div>
        {workspace && <p className="ms-folder" title={workspace.path}>{workspace.name}</p>}
        <div className="ms-tree">
          {loading ? (
            <p className="ms-hint"><Loader2 className="inline animate-spin" size={12} /> Loading…</p>
          ) : !workspace ? (
            <p className="ms-hint">Choose a folder to see the documents in it.</p>
          ) : tree.length ? (
            tree.map((node) => renderNode(node, 0))
          ) : (
            <p className="ms-hint">No Word, Excel or PowerPoint files in this folder.</p>
          )}
        </div>
      </aside>

      <section className="ms-main">
        <header className="ms-header">
          {activeFile ? (
            <>
              <span className="ms-title">{activeFile.name}</span>
              <span className="ms-kind">
                {KIND_LABEL[activeFile.kind]}
                {activeFile.kind !== 'sheet' && ' · read-only'}
                {dirty && ' · unsaved changes'}
              </span>
              <span className="flex-1" />
              <button className="ms-ghost" onClick={() => void officeApi.reveal(activeFile.path)}>
                Show in folder
              </button>
              <button
                className="ms-icon-button"
                onClick={() => setAssistant((a) => !a)}
                title={assistant ? 'Hide the assistant' : 'Show the assistant'}
                aria-label={assistant ? 'Hide the assistant' : 'Show the assistant'}
              >
                {assistant ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
              </button>
            </>
          ) : (
            <span className="ms-title muted">MS-Studio</span>
          )}
        </header>

        <div className="ms-body">
          {!activeFile ? (
            <div className="ms-empty">
              <div className="ms-empty-icon"><FileSpreadsheet size={26} /></div>
              <h2>Open a document</h2>
              <p>
                Spreadsheets open in an editable grid and save back to the same file. Word documents and
                presentations are shown read-only.
              </p>
            </div>
          ) : activeFile.kind === 'sheet' ? (
            <SheetEditor
              key={activeFile.path}
              file={activeFile.path}
              onDirtyChange={setDirty}
              onSaved={() => void refresh()}
              onNotify={notify}
            />
          ) : activeFile.kind === 'word' ? (
            <WordViewer key={activeFile.path} file={activeFile.path} legacy={activeFile.legacy} />
          ) : (
            <SlideViewer key={activeFile.path} file={activeFile.path} legacy={activeFile.legacy} />
          )}
        </div>
      </section>

      {assistant && <AssistantPanel file={activeFile?.path ?? null} fileName={activeFile?.name ?? ''} />}

      {toast && (
        <div className={`ms-toast ${toast.type}`} role={toast.type === 'error' ? 'alert' : 'status'}>
          <span>{toast.message}</span>
          <button onClick={() => setToast(null)} aria-label="Dismiss"><X size={13} /></button>
        </div>
      )}
    </div>
  );
}
