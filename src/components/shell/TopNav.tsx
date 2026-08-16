import { Link, NavLink } from 'react-router-dom';

const LINKS = [
  { to: '/chat', label: 'Chat' },
  { to: '/research', label: 'Research' },
  { to: '/pdf', label: 'PDF Tools' },
];

export default function TopNav({
  onOpenSettings,
}: {
  onOpenSettings: () => void;
}) {
  return (
    // `app-titlebar` makes this header the window's drag region and reserves
    // room on the right for the Windows caption buttons that Electron paints
    // over it (see titleBarOverlay in electron/main.ts).
    <header className="app-titlebar flex h-[68px] shrink-0 items-center justify-between pl-6">
      {/* Logo → workspace */}
      <Link
        to="/chat"
        className="glass neon-glow flex items-center gap-2 rounded-xl px-4 py-2 transition hover:brightness-110"
      >
        <span className="text-neon text-lg">✦</span>
        <span className="text-sm font-bold tracking-[0.2em] text-white">
          IMAGINARIUM
        </span>
      </Link>

      {/* Center nav */}
      <nav className="hidden items-center gap-1 md:flex">
        {LINKS.map((l) => (
          <NavLink
            key={l.to}
            to={l.to}
            className={({ isActive }) =>
              `rounded-lg px-4 py-2 text-sm transition-colors ${
                isActive
                  ? 'font-semibold text-white'
                  : 'text-[var(--color-teal)]/80 hover:text-white'
              }`
            }
          >
            {l.label}
          </NavLink>
        ))}
      </nav>

      {/* Settings */}
      <div className="flex items-center gap-3">
        <button
          onClick={onOpenSettings}
          aria-label="Settings"
          title="Settings"
          className="glass grid h-9 w-9 place-items-center rounded-full text-white/80 transition-colors hover:text-white"
        >
          ⚙
        </button>
      </div>
    </header>
  );
}
