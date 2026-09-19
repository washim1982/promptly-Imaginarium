import type { ReactNode } from 'react';
import { IconFiles, IconHistory, IconSettings, IconSourceControl } from './icons';

export type ActivityView = 'explorer' | 'commit' | 'history';

interface ActivityBarProps {
  active: ActivityView;
  onSelect: (view: ActivityView) => void;
  onOpenSettings: () => void;
  changedCount: number;
}

export function ActivityBar({ active, onSelect, onOpenSettings, changedCount }: ActivityBarProps) {
  return (
    <nav className="svn-activity" aria-label="SVN views">
      <div className="svn-activity__items">
        <ActivityItem
          icon={<IconFiles size={19} />}
          active={active === 'explorer'}
          title="Explorer"
          onClick={() => onSelect('explorer')}
        />
        <ActivityItem
          icon={<IconSourceControl size={19} />}
          active={active === 'commit'}
          title="Source Control"
          badge={changedCount > 0 ? changedCount : undefined}
          onClick={() => onSelect('commit')}
        />
        <ActivityItem
          icon={<IconHistory size={19} />}
          active={active === 'history'}
          title="History"
          onClick={() => onSelect('history')}
        />
      </div>
      <ActivityItem icon={<IconSettings size={19} />} active={false} title="SVN Settings" onClick={onOpenSettings} />
    </nav>
  );
}

function ActivityItem({
  icon,
  active,
  title,
  onClick,
  badge,
}: {
  icon: ReactNode;
  active: boolean;
  title: string;
  onClick: () => void;
  badge?: number;
}) {
  return (
    <button
      className={`svn-activity__item ${active ? 'svn-activity__item--active' : ''}`}
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
    >
      {active && <span className="svn-activity__indicator" />}
      {icon}
      {badge !== undefined && <span className="svn-activity__badge">{badge > 99 ? '99+' : badge}</span>}
    </button>
  );
}
