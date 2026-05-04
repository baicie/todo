import { ArrowDown, ArrowUp, Check, Clock, History, Search, X } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  type SortOption,
  addSearchHistory,
  useSearch,
  useSearchHistory,
} from '@baicie/orbit-hooks';
import { Button, Input } from '@baicie/orbit-ui';
import type { Task } from '@baicie/orbit';

interface SearchPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

const SORT_LABELS: Record<SortOption, string> = {
  createdAt: '创建时间',
  updatedAt: '更新时间',
  dueDate: '截止日期',
  title: '标题',
  importance: '重要性',
};

function TaskResult({ task, onClose }: { task: Task; onClose: () => void }) {
  const navigate = useNavigate();

  const handleClick = () => {
    navigate(`/tasks/my-day`);
    onClose();
  };

  return (
    <Button
      variant="ghost"
      onClick={handleClick}
      className="w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors border-b border-gray-100 last:border-b-0"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5">
          <div
            className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
              task.isCompleted
                ? 'bg-[var(--theme-primary)] border-[var(--theme-primary)]'
                : 'border-gray-300'
            }`}
          >
            {task.isCompleted && <Check size={10} className="text-white" />}
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <p
            className={`text-sm font-medium truncate ${
              task.isCompleted ? 'text-gray-400 line-through' : 'text-gray-900'
            }`}
          >
            {task.title}
          </p>
          {task.description && (
            <p className="text-xs text-gray-500 truncate mt-0.5">{task.description}</p>
          )}
          <div className="flex items-center gap-3 mt-1">
            {task.dueDate && (
              <span className="text-xs text-gray-400">
                截止: {new Date(task.dueDate).toLocaleDateString('zh-CN')}
              </span>
            )}
            {task.isImportant && <span className="text-xs text-amber-500">重要</span>}
            {task.tagIds && task.tagIds.length > 0 && (
              <span className="text-xs text-blue-500">{task.tagIds.length} 个标签</span>
            )}
          </div>
        </div>
      </div>
    </Button>
  );
}

export function SearchPanel({ isOpen, onClose }: SearchPanelProps) {
  const navigate = useNavigate();
  const {
    query,
    setQuery,
    sortBy,
    setSort,
    sortOrder,
    toggleSortOrder,
    tasks: searchResults,
    isLoading,
  } = useSearch();
  const { history, removeHistory, clearHistory } = useSearchHistory();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  const handleSubmit = useCallback(
    (q: string) => {
      if (q.trim()) {
        addSearchHistory(q.trim());
        navigate(`/tasks/my-day`);
        onClose();
      }
    },
    [navigate, onClose],
  );

  if (!isOpen) return null;

  const showResults = query.trim().length > 0;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]"
        onClick={onClose}
      >
        <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" aria-hidden="true" />
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: -10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: -10 }}
          transition={{ duration: 0.15 }}
          className="relative w-full max-w-xl bg-white rounded-xl shadow-2xl overflow-hidden mx-4"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Search Input */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100">
            <Search size={18} className="text-gray-400 flex-shrink-0" />
            <Input
              ref={inputRef as React.RefObject<HTMLInputElement>}
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSubmit(query);
                if (e.key === 'Escape') onClose();
              }}
              placeholder="搜索任务..."
              className="flex-1 bg-transparent border-none outline-none text-gray-900 placeholder:text-gray-400 text-sm"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
            />
            {query && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  setQuery('');
                }}
                className="p-1 hover:bg-gray-100 rounded text-gray-400"
              >
                <X size={14} />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="p-1 hover:bg-gray-100 rounded text-gray-400"
            >
              <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 text-xs text-gray-400 bg-gray-100 rounded border border-gray-200">
                Esc
              </kbd>
            </Button>
          </div>

          {/* Search Results */}
          {showResults ? (
            <div className="max-h-[400px] overflow-y-auto">
              {/* Sort Bar */}
              <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-100 bg-gray-50/50">
                <span className="text-xs text-gray-500">排序：</span>
                <div className="flex items-center gap-1">
                  {(Object.keys(SORT_LABELS) as SortOption[]).map((opt) => (
                    <Button
                      key={opt}
                      variant="ghost"
                      size="sm"
                      onClick={() => setSort(opt)}
                      className={`px-2 py-1 text-xs rounded transition-colors ${
                        sortBy === opt
                          ? 'bg-blue-100 text-blue-600 font-medium'
                          : 'text-gray-500 hover:bg-gray-100'
                      }`}
                    >
                      {SORT_LABELS[opt]}
                    </Button>
                  ))}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={toggleSortOrder}
                  className="p-1 hover:bg-gray-100 rounded text-gray-400"
                  title={sortOrder === 'asc' ? '升序' : '降序'}
                >
                  {sortOrder === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
                </Button>
              </div>

              {isLoading ? (
                <div className="px-4 py-8 text-center text-sm text-gray-400">搜索中...</div>
              ) : searchResults.length === 0 ? (
                <div className="px-4 py-8 text-center">
                  <p className="text-sm text-gray-500">没有找到匹配的任务</p>
                  <p className="text-xs text-gray-400 mt-1">尝试其他关键词</p>
                </div>
              ) : (
                <div>
                  <div className="px-4 py-1.5 bg-gray-50/50 border-b border-gray-100">
                    <span className="text-xs text-gray-400">{searchResults.length} 个结果</span>
                  </div>
                  {searchResults.slice(0, 20).map((task) => (
                    <TaskResult key={task.id} task={task} onClose={onClose} />
                  ))}
                  {searchResults.length > 20 && (
                    <div className="px-4 py-3 text-center text-xs text-gray-400 bg-gray-50/50">
                      还有 {searchResults.length - 20} 个结果
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            /* Search History */
            <div className="max-h-[300px] overflow-y-auto py-2">
              {history.length === 0 ? (
                <div className="px-4 py-6 text-center text-sm text-gray-400">
                  <History size={24} className="mx-auto mb-2 opacity-50" />
                  <p>暂无搜索历史</p>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between px-4 py-1">
                    <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                      搜索历史
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={clearHistory}
                      className="text-xs text-gray-400 hover:text-red-500 transition-colors"
                    >
                      清空
                    </Button>
                  </div>
                  {history.map((item) => (
                    <div
                      key={item}
                      className="flex items-center gap-2 px-4 py-2 hover:bg-gray-50 group"
                    >
                      <Clock size={14} className="text-gray-300 flex-shrink-0" />
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setQuery(item);
                        }}
                        className="flex-1 text-sm text-gray-700 text-left truncate justify-start"
                      >
                        {item}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeHistory(item);
                        }}
                        className="p-1 opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 transition-all"
                      >
                        <X size={12} />
                      </Button>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}

          {/* Footer */}
          <div className="flex items-center justify-between px-4 py-2 border-t border-gray-100 bg-gray-50 text-xs text-gray-400">
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1">
                <kbd className="px-1 py-0.5 bg-white rounded border border-gray-200">Enter</kbd>{' '}
                搜索
              </span>
              <span className="flex items-center gap-1">
                <kbd className="px-1 py-0.5 bg-white rounded border border-gray-200">↑</kbd>
                <kbd className="px-1 py-0.5 bg-white rounded border border-gray-200">↓</kbd> 导航
              </span>
            </div>
            {showResults && query.trim() && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setQuery('');
                }}
                className="text-blue-500 hover:text-blue-600"
              >
                清除搜索
              </Button>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
