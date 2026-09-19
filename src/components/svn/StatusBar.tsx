import { IconAlert, IconCheck, IconSourceControl } from './icons';

interface StatusBarProps {
  configured: boolean;
  repoLabel: string;
  changedCount: number;
  conflictedCount: number;
  busy: boolean;
  language: string;
  reviewModel: string;
  reviewModelReady: boolean;
}

export function StatusBar({
  configured,
  repoLabel,
  changedCount,
  conflictedCount,
  busy,
  language,
  reviewModel,
  reviewModelReady,
}: StatusBarProps) {
  return (
    <footer className="svn-statusbar">
      <div className="svn-statusbar__side">
        <span className="svn-statusbar__item">
          <span
            className={`svn-statusbar__dot ${
              busy ? 'svn-statusbar__dot--busy' : configured ? 'svn-statusbar__dot--live' : ''
            }`}
          />
          <IconSourceControl size={12} />
          {configured ? repoLabel : 'no working copy'}
        </span>
        {configured && (
          <>
            <span className="svn-statusbar__item" title="Changed items">
              <IconCheck size={12} />
              {changedCount}
            </span>
            <span
              className={`svn-statusbar__item ${conflictedCount > 0 ? 'svn-statusbar__item--danger' : ''}`}
              title="Conflicts"
            >
              <IconAlert size={12} />
              {conflictedCount}
            </span>
          </>
        )}
      </div>
      <div className="svn-statusbar__side">
        <span className="svn-statusbar__item">{busy ? 'Syncing…' : 'Idle'}</span>
        <span className="svn-statusbar__item">{language}</span>
        <span className="svn-statusbar__item" title="Model used for AI review">
          <span className={`svn-statusbar__dot ${reviewModelReady ? 'svn-statusbar__dot--live' : ''}`} />
          AI · {reviewModel}
        </span>
      </div>
    </footer>
  );
}
