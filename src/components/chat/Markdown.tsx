import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import CodeBlock from './CodeBlock';

// Renders assistant markdown: headings, lists, tables (GFM), inline code, and
// fenced code blocks with syntax highlighting + copy.
export default function Markdown({ children }: { children: string }) {
  return (
    <div className="space-y-3 text-[15px] leading-relaxed text-white/90">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Block code -> highlighted CodeBlock; inline code -> styled span.
          code({ className, children, ...props }) {
            const text = String(children ?? '');
            const match = /language-(\w+)/.exec(className || '');
            const isBlock = match != null || text.includes('\n');
            if (isBlock) {
              return (
                <CodeBlock
                  language={match?.[1] ?? ''}
                  value={text.replace(/\n$/, '')}
                />
              );
            }
            return (
              <code
                className="rounded bg-white/10 px-1.5 py-0.5 font-[var(--font-mono)] text-[13px] text-[var(--color-neon-soft)]"
                {...props}
              >
                {children}
              </code>
            );
          },
          // <pre> would wrap our CodeBlock in invalid markup; pass through.
          pre: ({ children }) => <>{children}</>,
          h1: ({ children }) => (
            <h1 className="text-xl font-semibold text-white">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-lg font-semibold text-white">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="flex items-center gap-2 text-base font-semibold text-white">
              {children}
            </h3>
          ),
          p: ({ children }) => <p>{children}</p>,
          ul: ({ children }) => (
            <ul className="list-disc space-y-1 pl-5 marker:text-white/40">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal space-y-1 pl-5 marker:text-white/40">
              {children}
            </ol>
          ),
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-[var(--color-teal)] underline"
            >
              {children}
            </a>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold text-white">{children}</strong>
          ),
          hr: () => <hr className="border-white/10" />,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-[var(--color-neon)]/50 pl-3 text-white/70">
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-white/10 bg-white/5 px-3 py-1.5 text-left font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-white/10 px-3 py-1.5">{children}</td>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
