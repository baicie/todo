import { type FC, type RefObject, useCallback, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  minHeight?: number;
  className?: string;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
}

interface ToolbarAction {
  label: string;
  prefix: string;
  suffix: string;
  shortcut?: string;
}

const TOOLBAR_ACTIONS: ToolbarAction[] = [
  { label: 'B', prefix: '**', suffix: '**', shortcut: 'Ctrl+B' },
  { label: 'I', prefix: '_', suffix: '_', shortcut: 'Ctrl+I' },
  { label: '~~', prefix: '~~', suffix: '~~' },
  { label: '`', prefix: '`', suffix: '`' },
  { label: '🔗', prefix: '[', suffix: '](url)' },
  { label: '-', prefix: '\n- ', suffix: '' },
  { label: '1.', prefix: '\n1. ', suffix: '' },
  { label: '[ ]', prefix: '\n- [ ] ', suffix: '' },
];

const renderers: Components = {
  h1: ({ children }) => <h1 className="text-xl font-bold text-gray-900 mb-2 mt-3">{children}</h1>,
  h2: ({ children }) => (
    <h2 className="text-lg font-semibold text-gray-900 mb-2 mt-3">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-base font-semibold text-gray-900 mb-1 mt-2">{children}</h3>
  ),
  p: ({ children }) => <p className="text-sm text-gray-700 mb-2 leading-relaxed">{children}</p>,
  ul: ({ children }) => (
    <ul className="list-disc list-inside text-sm text-gray-700 mb-2 space-y-0.5">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal list-inside text-sm text-gray-700 mb-2 space-y-0.5">{children}</ol>
  ),
  li: ({ children }) => <li className="text-sm text-gray-700">{children}</li>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-blue-600 hover:underline"
    >
      {children}
    </a>
  ),
  code: ({ children, className }) => {
    const isInline = !className;
    if (isInline) {
      return (
        <code className="px-1 py-0.5 bg-gray-100 rounded text-xs font-mono text-pink-600">
          {children}
        </code>
      );
    }
    return (
      <code className="block w-full p-3 bg-gray-900 rounded text-xs font-mono text-green-400 overflow-x-auto mb-2">
        {children}
      </code>
    );
  },
  pre: ({ children }) => <pre className="mb-2">{children}</pre>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-3 border-blue-300 pl-3 py-1 my-2 bg-blue-50 text-sm text-gray-600 italic">
      {children}
    </blockquote>
  ),
  strong: ({ children }) => <strong className="font-semibold text-gray-900">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  hr: () => <hr className="my-3 border-gray-200" />,
};

export const MarkdownEditor: FC<MarkdownEditorProps> = ({
  value,
  onChange,
  onBlur,
  placeholder = '添加描述（支持 Markdown）...',
  minHeight = 100,
  className = '',
  textareaRef,
}) => {
  const [isFocused, setIsFocused] = useState(false);
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const ref = textareaRef ?? internalRef;

  const handleBlur = useCallback(() => {
    onBlur?.();
  }, [onBlur]);

  const applyFormat = useCallback(
    (prefix: string, suffix: string) => {
      const el = ref.current;
      if (!el) return;

      const start = el.selectionStart;
      const end = el.selectionEnd;
      const selected = value.slice(start, end);
      const newText = `${value.slice(0, start)}${prefix}${selected}${suffix}${value.slice(end)}`;
      onChange(newText);

      requestAnimationFrame(() => {
        el.focus();
        const newCursor = start + prefix.length + selected.length + suffix.length;
        el.setSelectionRange(newCursor, newCursor);
      });
    },
    [ref, value, onChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const modKey = e.metaKey || e.ctrlKey;

      if (modKey && e.key === 'b') {
        e.preventDefault();
        applyFormat('**', '**');
        return;
      }
      if (modKey && e.key === 'i') {
        e.preventDefault();
        applyFormat('_', '_');
        return;
      }

      if (e.key === 'Tab') {
        e.preventDefault();
        const el = ref.current;
        if (!el) return;
        const start = el.selectionStart;
        const end = el.selectionEnd;
        const newText = `${value.slice(0, start)}  ${value.slice(end)}`;
        onChange(newText);
        requestAnimationFrame(() => {
          el.setSelectionRange(start + 2, start + 2);
        });
      }
    },
    [applyFormat, ref, value, onChange],
  );

  const hasContent = value.trim().length > 0;

  return (
    <div className={`rounded-md border border-gray-200 overflow-hidden bg-white ${className}`}>
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-gray-100 bg-gray-50">
        {TOOLBAR_ACTIONS.map((action) => (
          <button
            key={action.label}
            type="button"
            onClick={() => applyFormat(action.prefix, action.suffix)}
            title={action.shortcut ? `${action.label} (${action.shortcut})` : action.label}
            className="w-7 h-7 flex items-center justify-center text-xs font-bold text-gray-500 hover:bg-gray-200 rounded transition-colors"
          >
            {action.label}
          </button>
        ))}
      </div>

      <div className="relative">
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          onBlurCapture={handleBlur}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="w-full bg-transparent border-none outline-none resize-none text-sm text-gray-900 placeholder:text-gray-400 p-3 leading-relaxed"
          style={{ minHeight }}
          spellCheck={false}
        />

        {!isFocused && hasContent && (
          <div className="absolute inset-0 pointer-events-none overflow-auto" style={{ minHeight }}>
            <div className="p-3">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={renderers}>
                {value}
              </ReactMarkdown>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
