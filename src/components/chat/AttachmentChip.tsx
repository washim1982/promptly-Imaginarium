import { FileText, HardDrive, Mail, X } from 'lucide-react';
import { KIND_LABEL, type AttachmentMeta } from '../../lib/attachments';

const ICONS = { email: Mail, drive: HardDrive, file: FileText } as const;

/** An attached email / Drive file / workspace file, in the composer or on a sent message. */
export default function AttachmentChip({ attachment, onRemove }: { attachment: AttachmentMeta; onRemove?: () => void }) {
  const Icon = ICONS[attachment.kind];
  const tip = `${KIND_LABEL[attachment.kind]}: ${attachment.title}${attachment.subtitle ? ` — ${attachment.subtitle}` : ''}${
    attachment.truncated ? ' (shortened to fit the model)' : ''
  }`;
  return (
    <span
      title={tip}
      className="flex max-w-[260px] items-center gap-1.5 rounded-lg border border-white/12 bg-white/[0.05] py-1 pl-2 pr-1.5 text-[11.5px] text-white/80"
    >
      <Icon size={13} className="shrink-0 text-[var(--color-neon)]" />
      <span className="min-w-0 truncate">{attachment.title}</span>
      {attachment.subtitle && <span className="hidden min-w-0 max-w-[90px] truncate text-white/35 sm:inline">· {attachment.subtitle}</span>}
      {attachment.truncated && <span className="mono shrink-0 text-[9px] text-amber-300/80">CUT</span>}
      {onRemove && (
        <button onClick={onRemove} className="shrink-0 rounded p-0.5 text-white/40 hover:bg-white/10 hover:text-white" aria-label={`Remove ${attachment.title}`}>
          <X size={11} />
        </button>
      )}
    </span>
  );
}
