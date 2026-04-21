import { Search } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { List } from '@baicie/orbit';
import { useCreateTask, useList } from '@baicie/orbit-hooks';

interface Command {
  id: string;
  label: string;
  category: string;
  icon: React.ReactNode;
  shortcut?: string;
  action: () => void;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CommandPalette({ isOpen, onClose }: CommandPaletteProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: lists = [] } = useList();
  const createTask = useCreateTask();

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const commands: Command[] = useMemo(() => {
    const base: Command[] = [
      {
        id: 'new-task',
        label: '新建任务',
        category: '任务',
        icon: <PlusIcon />,
        shortcut: 'N',
        action: () => {
          const title = query.trim();
          if (title) createTask.mutate({ title });
          onClose();
        },
      },
      {
        id: 'goto-my-day',
        label: '前往「我的一天」',
        category: '导航',
        icon: <SunIcon />,
        shortcut: '1',
        action: () => {
          navigate('/tasks/my-day');
          onClose();
        },
      },
      {
        id: 'goto-important',
        label: '前往「重要」',
        category: '导航',
        icon: <StarIcon />,
        shortcut: '2',
        action: () => {
          navigate('/tasks/important');
          onClose();
        },
      },
      {
        id: 'goto-planned',
        label: '前往「已计划」',
        category: '导航',
        icon: <CalendarIcon />,
        shortcut: '3',
        action: () => {
          navigate('/tasks/planned');
          onClose();
        },
      },
      {
        id: 'goto-tasks',
        label: '前往「所有任务」',
        category: '导航',
        icon: <ListIcon />,
        shortcut: '4',
        action: () => {
          navigate('/tasks/tasks');
          onClose();
        },
      },
    ];

    const listCommands: Command[] = lists.map((list: List) => ({
      id: `goto-list-${list.id}`,
      label: `前往「${list.title}」`,
      category: '清单',
      icon: <ListIcon />,
      action: () => {
        navigate(`/tasks/${list.id}`);
        onClose();
      },
    }));

    return [...base, ...listCommands];
  }, [lists, query, navigate, createTask, onClose]);

  const filtered = useMemo(() => {
    if (!query.trim()) return commands;
    const q = query.toLowerCase();
    return commands.filter(
      (cmd) =>
        cmd.label.toLowerCase().includes(q) ||
        cmd.category.toLowerCase().includes(q) ||
        cmd.id.toLowerCase().includes(q),
    );
  }, [commands, query]);

  const grouped = useMemo(() => {
    const groups: Record<string, Command[]> = {};
    for (const cmd of filtered) {
      if (!groups[cmd.category]) groups[cmd.category] = [];
      groups[cmd.category].push(cmd);
    }
    return groups;
  }, [filtered]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const executeSelected = useCallback(() => {
    if (filtered.length > 0 && selectedIndex >= 0 && selectedIndex < filtered.length) {
      filtered[selectedIndex].action();
    }
  }, [filtered, selectedIndex]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        executeSelected();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    },
    [filtered, executeSelected, onClose],
  );

  useEffect(() => {
    if (!isOpen) return;
    function handleGlobalKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleGlobalKey);
    return () => window.removeEventListener('keydown', handleGlobalKey);
  }, [isOpen, onClose]);

  let flatIndex = 0;

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
        onClick={onClose}
      >
        <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" aria-hidden="true" />
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: -10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: -10 }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
          className="relative w-full max-w-lg bg-white rounded-xl shadow-2xl overflow-hidden mx-4"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label="命令面板"
        >
          <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100">
            <Search size={18} className="text-gray-400 flex-shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="输入命令或搜索..."
              className="flex-1 bg-transparent border-none outline-none text-gray-900 placeholder:text-gray-400 text-sm"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 text-xs text-gray-400 bg-gray-100 rounded border border-gray-200">
              Esc
            </kbd>
          </div>

          <div className="max-h-[320px] overflow-y-auto py-2" role="listbox" aria-label="可用命令">
            {filtered.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-gray-400">没有找到匹配的命令</div>
            ) : (
              Object.entries(grouped).map(([category, cmds]) => (
                <div key={category}>
                  <div className="px-4 py-1.5 text-xs font-medium text-gray-400 uppercase tracking-wider">
                    {category}
                  </div>
                  {cmds.map((cmd) => {
                    const isSelected = flatIndex === selectedIndex;
                    const currentIndex = flatIndex;
                    flatIndex++;
                    return (
                      <button
                        key={cmd.id}
                        className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                          isSelected ? 'bg-blue-50 text-blue-600' : 'text-gray-700 hover:bg-gray-50'
                        }`}
                        onClick={cmd.action}
                        onMouseEnter={() => setSelectedIndex(currentIndex)}
                        role="option"
                        aria-selected={isSelected}
                      >
                        <span
                          className={`flex-shrink-0 ${isSelected ? 'text-blue-500' : 'text-gray-400'}`}
                        >
                          {cmd.icon}
                        </span>
                        <span className="flex-1 text-sm truncate">{cmd.label}</span>
                        {cmd.shortcut && (
                          <kbd className="flex-shrink-0 text-xs px-1.5 py-0.5 text-gray-400 bg-gray-100 rounded border border-gray-200">
                            {cmd.shortcut}
                          </kbd>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>

          <div className="flex items-center gap-4 px-4 py-2 border-t border-gray-100 bg-gray-50 text-xs text-gray-400">
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 bg-white rounded border border-gray-200">↑</kbd>
              <kbd className="px-1 py-0.5 bg-white rounded border border-gray-200">↓</kbd>
              导航
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 bg-white rounded border border-gray-200">↵</kbd>
              执行
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 bg-white rounded border border-gray-200">Esc</kbd>
              关闭
            </span>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

function PlusIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function StarIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  );
}
