import { useState } from 'react';
import type { SvnTreeNode } from '../../lib/svn/types';
import { nameClass, sortNodes, STATUS_ICON, statusBadgeClass } from '../../lib/svn/utils';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import {
  IconFile,
  IconFilePlus,
  IconFolder,
  IconFolderPlus,
  IconFolderUp,
  IconLock,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconUpload,
} from './icons';

export interface FileTreeActions {
  onSelectFile: (path: string) => void;
  /** Native picker: add files (kind "files") or a whole folder into targetFolder. */
  onUpload: (targetFolder: string, kind: 'files' | 'folder') => void;
  /** Files dragged in from Windows Explorer and dropped on a folder. */
  onDropFiles: (targetFolder: string, files: FileList) => void;
  onCreateFile: (targetFolder: string) => void;
  onCreateFolder: (targetFolder: string) => void;
  onDelete: (path: string) => void;
  onRename: (path: string) => void;
  onCommitSelected: (path: string) => void;
  onRevert: (path: string) => void;
  onViewHistory: (path: string) => void;
}

interface FileTreeProps extends FileTreeActions {
  root: SvnTreeNode | null;
  selectedPath: string | null;
  repoName: string;
  onRefresh: () => void;
}

export function FileTree({ root, selectedPath, repoName, onRefresh, ...actions }: FileTreeProps) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const openMenu = (x: number, y: number, items: ContextMenuItem[]) => setMenu({ x, y, items });

  return (
    <div>
      <div className="svn-explorer-header">
        <span className="svn-label">Explorer</span>
        <div className="svn-explorer-actions">
          <button className="svn-icon-btn" title="New file" onClick={() => actions.onCreateFile('')}>
            <IconFilePlus size={14} />
          </button>
          <button className="svn-icon-btn" title="New folder" onClick={() => actions.onCreateFolder('')}>
            <IconFolderPlus size={14} />
          </button>
          <button className="svn-icon-btn" title="Refresh" onClick={onRefresh}>
            <IconRefresh size={14} />
          </button>
        </div>
      </div>
      {repoName && (
        <div className="svn-explorer-project" title={repoName}>
          {repoName}
        </div>
      )}
      <div className="svn-tree-toolbar">
        <button className="svn-icon-btn" title="Add file(s) to the root" onClick={() => actions.onUpload('', 'files')}>
          <IconUpload size={13} /> Files
        </button>
        <button className="svn-icon-btn" title="Add a folder to the root" onClick={() => actions.onUpload('', 'folder')}>
          <IconFolderUp size={13} /> Folder
        </button>
      </div>
      {root ? (
        // The root's children are listed directly — a "/" row adds nothing.
        sortNodes(root.children ?? []).map((child) => (
          <TreeNode
            key={child.path}
            node={child}
            depth={0}
            selectedPath={selectedPath}
            onContextMenu={openMenu}
            {...actions}
          />
        ))
      ) : (
        <div className="svn-muted-note">No working copy loaded.</div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={menu.items} />}
    </div>
  );
}

function buildMenuItems(node: SvnTreeNode, actions: FileTreeActions): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  const sep = { separator: true, label: '', onClick: () => {} };
  if (node.isDirectory) {
    items.push(...uploadMenuItems(node, actions));
    items.push({ label: 'New file', onClick: () => actions.onCreateFile(node.path) });
    items.push({ label: 'New folder', onClick: () => actions.onCreateFolder(node.path) });
    items.push(sep);
  }
  items.push({ label: 'Commit…', onClick: () => actions.onCommitSelected(node.path) });
  items.push({ label: 'Revert', onClick: () => actions.onRevert(node.path) });
  items.push({ label: 'View history', onClick: () => actions.onViewHistory(node.path) });
  items.push(sep);
  items.push({ label: 'Rename', onClick: () => actions.onRename(node.path) });
  items.push({ label: 'Delete', danger: true, onClick: () => actions.onDelete(node.path) });
  return items;
}

function uploadMenuItems(node: SvnTreeNode, actions: FileTreeActions): ContextMenuItem[] {
  return [
    { label: 'Add file(s) here…', onClick: () => actions.onUpload(node.path, 'files') },
    { label: 'Add folder here…', onClick: () => actions.onUpload(node.path, 'folder') },
  ];
}

interface TreeNodeProps extends FileTreeActions {
  node: SvnTreeNode;
  depth: number;
  selectedPath: string | null;
  onContextMenu: (x: number, y: number, items: ContextMenuItem[]) => void;
}

function TreeNode({ node, depth, selectedPath, onContextMenu, ...actions }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(depth < 1);
  const [dragOver, setDragOver] = useState(false);
  const isSelected = selectedPath === node.path;

  function handleClick() {
    if (node.isDirectory) setExpanded((e) => !e);
    else actions.onSelectFile(node.path);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (node.isDirectory && e.dataTransfer.files.length > 0) actions.onDropFiles(node.path, e.dataTransfer.files);
  }

  return (
    <div className="svn-tree">
      <div
        className={`svn-tree__row ${isSelected ? 'svn-tree__row--selected' : ''} ${
          dragOver ? 'svn-tree__row--dragover' : ''
        }`}
        style={{ paddingLeft: 6 + depth * 2 }}
        onClick={handleClick}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu(e.clientX, e.clientY, buildMenuItems(node, actions));
        }}
        onDragOver={(e) => {
          if (!node.isDirectory) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        <span className="svn-tree__caret">{node.isDirectory ? (expanded ? '▾' : '▸') : ''}</span>
        <span className={`svn-tree__icon ${node.isDirectory ? 'svn-tree__icon--dir' : ''}`}>
          {node.isDirectory ? <IconFolder size={14} /> : <IconFile size={14} />}
        </span>
        <span className={`svn-tree__name ${nameClass(node.status)}`}>{node.name}</span>
        {node.locked && (
          <span className="svn-tree__lock" title="Locked">
            <IconLock size={12} />
          </span>
        )}
        {node.status !== 'normal' && (
          <span className={statusBadgeClass(node.status)} title={node.status}>
            {STATUS_ICON[node.status] ?? node.status}
          </span>
        )}
        <span className="svn-tree__row-actions">
          {node.isDirectory && (
            <button
              className="svn-tree__row-action"
              title="Add files or a folder here"
              onClick={(e) => {
                e.stopPropagation();
                onContextMenu(e.clientX, e.clientY, uploadMenuItems(node, actions));
              }}
            >
              <IconPlus size={12} />
            </button>
          )}
          <button
            className="svn-tree__row-action"
            title="Rename"
            onClick={(e) => {
              e.stopPropagation();
              actions.onRename(node.path);
            }}
          >
            <IconPencil size={12} />
          </button>
          <button
            className="svn-tree__row-action svn-tree__row-action--danger"
            title="Delete"
            onClick={(e) => {
              e.stopPropagation();
              actions.onDelete(node.path);
            }}
          >
            <IconTrash size={12} />
          </button>
        </span>
      </div>
      {node.isDirectory && expanded && node.children && node.children.length > 0 && (
        <div className="svn-tree__children">
          {sortNodes(node.children).map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onContextMenu={onContextMenu}
              {...actions}
            />
          ))}
        </div>
      )}
    </div>
  );
}
