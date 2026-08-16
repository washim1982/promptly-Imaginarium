import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { desktop, type AppInfo } from '../../lib/desktop';

export default function Footer() {
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    let active = true;
    desktop?.info().then((i) => {
      if (active) setInfo(i);
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <footer className="mono flex shrink-0 items-center justify-center gap-3 py-5 text-[10px] text-white/30">
      <span title={info ? `Electron ${info.electron} · Chromium ${info.chrome}` : ''}>
        Imaginarium {info?.version ?? ''}
      </span>
      <span>·</span>
      <Link to="/about" className="hover:text-white/60">
        About
      </Link>
      <span>·</span>
      <Link to="/privacy" className="hover:text-white/60">
        Privacy
      </Link>
    </footer>
  );
}
