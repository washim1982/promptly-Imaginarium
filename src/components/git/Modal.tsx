import { useEffect, type ReactNode } from 'react';
import { LoaderCircle, X } from 'lucide-react';

interface ModalProps {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  width?: 'default' | 'wide';
}

export function Modal({ title, subtitle, onClose, children, width = 'default' }: ModalProps) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);

  return (
    <div className="gs-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className={`gs-modal ${width === 'wide' ? 'gs-modal-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="gs-modal-heading">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="gs-icon-button quiet" onClick={onClose} aria-label="Close">
            <X size={19} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

export function Spinner({ size = 17 }: { size?: number }) {
  return <LoaderCircle className="gs-spin" size={size} />;
}
