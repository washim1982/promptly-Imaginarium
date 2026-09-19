import { useEffect, useRef } from 'react';
import type { SvnTreeNode } from '../../lib/svn/types';
import { collectChangedPaths, nameClass, sortNodes, STATUS_ICON, statusBadgeClass } from '../../lib/svn/utils';
import { IconFile, IconFolder } from './icons';

interface ChangesTreeProps {
  root: SvnTreeNode;
  checked: Set<string>;
  onToggle: (paths: string[], value: boolean) => void;
  onOpen: (path: string) => void;
}

export function ChangesTree({ root, checked, onToggle, onOpen }: ChangesTreeProps) {
  return (
    <div className="svn-changes">
      {/* The working-copy root has its own properties (svn:ignore usually lives
          here). Committing it recurses over everything, so its checkbox only
          governs the root item — the commit guard asks for the rest explicitly. */}
      {root.status !== 'normal' && (
        <div className="svn-tree">
          <div className="svn-tree__row" style={{ paddingLeft: 6 }}>
            <input
              type="checkbox"
              checked={checked.has('')}
              onChange={() => onToggle([''], !checked.has(''))}
              aria-label="Select working-copy root properties"
            />
            <span className="svn-tree__icon svn-tree__icon--dir">
              <IconFolder size={14} />
            </span>
            <span className={`svn-tree__name ${nameClass(root.status)}`}>
              Working-copy root <span style={{ color: 'var(--svn-muted)' }}>· properties</span>
            </span>
            <span className={statusBadgeClass(root.status)} title={`${root.status} (properties)`}>
              {STATUS_ICON[root.status] ?? root.status}
            </span>
          </div>
        </div>
      )}
      {sortNodes(root.children ?? []).map((child) => (
        <ChangeRow key={child.path} node={child} depth={0} checked={checked} onToggle={onToggle} onOpen={onOpen} />
      ))}
    </div>
  );
}

function ChangeRow({
  node,
  depth,
  checked,
  onToggle,
  onOpen,
}: {
  node: SvnTreeNode;
  depth: number;
  checked: Set<string>;
  onToggle: (paths: string[], value: boolean) => void;
  onOpen: (path: string) => void;
}) {
  const checkboxRef = useRef<HTMLInputElement>(null);
  const changedInSubtree = collectChangedPaths(node);
  const allChecked = changedInSubtree.length > 0 && changedInSubtree.every((p) => checked.has(p));
  const someChecked = changedInSubtree.some((p) => checked.has(p));
  const isOwnChange = node.status !== 'normal';

  useEffect(() => {
    if (checkboxRef.current) checkboxRef.current.indeterminate = someChecked && !allChecked;
  }, [someChecked, allChecked]);

  return (
    <div className="svn-tree">
      {/* New: clicking a changed file's row opens it (and its diff) in the editor. */}
      <div
        className="svn-tree__row"
        style={{ paddingLeft: 6 + depth * 12, cursor: node.isDirectory ? 'default' : 'pointer' }}
        onClick={() => !node.isDirectory && onOpen(node.path)}
      >
        <input
          ref={checkboxRef}
          type="checkbox"
          checked={allChecked}
          disabled={changedInSubtree.length === 0}
          onClick={(e) => e.stopPropagation()}
          onChange={() => onToggle(changedInSubtree, !allChecked)}
          aria-label={`Select ${node.path}`}
        />
        <span className={`svn-tree__icon ${node.isDirectory ? 'svn-tree__icon--dir' : ''}`}>
          {node.isDirectory ? <IconFolder size={14} /> : <IconFile size={14} />}
        </span>
        <span className={`svn-tree__name ${isOwnChange ? nameClass(node.status) : ''}`}>{node.name}</span>
        {isOwnChange && (
          <span className={statusBadgeClass(node.status)} title={node.status}>
            {STATUS_ICON[node.status] ?? node.status}
          </span>
        )}
      </div>
      {node.children && node.children.length > 0 && (
        <div className="svn-tree__children">
          {sortNodes(node.children).map((child) => (
            <ChangeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              checked={checked}
              onToggle={onToggle}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </div>
  );
}
