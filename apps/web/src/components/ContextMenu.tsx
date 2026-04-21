import { CheckCircle, Circle, Copy, Star, Sun, Trash2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { Task } from '@baicie/orbit';

interface ContextMenuProps {
  x: number;
  y: number;
  task: Task;
  onClose: () => void;
  onToggleComplete: () => void;
  onToggleImportant: () => void;
  onToggleMyDay: () => void;
  onDelete: () => void;
}

export const ContextMenu = ({
  x,
  y,
  task,
  onClose,
  onToggleComplete,
  onToggleImportant,
  onToggleMyDay,
  onDelete,
}: ContextMenuProps) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    const handleScroll = () => onClose();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('scroll', handleScroll, true);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('scroll', handleScroll, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  // Adjust position if menu goes off screen
  const menuWidth = 224; // w-56 = 14rem = ~224px
  const menuHeight = 280; // approximate menu height
  const adjustedX = Math.min(x, window.innerWidth - menuWidth - 8);
  const adjustedY = Math.min(y, window.innerHeight - menuHeight - 8);

  const style: React.CSSProperties = {
    top: Math.max(8, adjustedY),
    left: Math.max(8, adjustedX),
  };

  return (
    <div
      ref={menuRef}
      className="fixed z-50 w-56 bg-white rounded-md shadow-lg border border-gray-200 py-1 text-sm text-gray-700 animate-in fade-in zoom-in-95 duration-100"
      style={style}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        onClick={() => {
          onToggleMyDay();
          onClose();
        }}
        className="w-full px-4 py-2 flex items-center gap-3 hover:bg-gray-100 transition-colors text-left"
      >
        <Sun size={16} />
        <span>{task.addToMyDay ? '从“我的一天”移除' : '添加到“我的一天”'}</span>
      </button>

      <button
        onClick={() => {
          onToggleImportant();
          onClose();
        }}
        className="w-full px-4 py-2 flex items-center gap-3 hover:bg-gray-100 transition-colors text-left"
      >
        <Star
          size={16}
          fill={task.isImportant ? 'currentColor' : 'none'}
          className={task.isImportant ? 'text-[var(--theme-primary)]' : ''}
        />
        <span>{task.isImportant ? '取消标记为重要' : '标记为重要'}</span>
      </button>

      <button
        onClick={() => {
          onToggleComplete();
          onClose();
        }}
        className="w-full px-4 py-2 flex items-center gap-3 hover:bg-gray-100 transition-colors text-left"
      >
        {task.isCompleted ? <Circle size={16} /> : <CheckCircle size={16} />}
        <span>{task.isCompleted ? '标记为未完成' : '标记为已完成'}</span>
      </button>

      <div className="my-1 border-t border-gray-100" />

      <button
        onClick={() => {
          onClose();
        }}
        className="w-full px-4 py-2 flex items-center gap-3 hover:bg-gray-100 transition-colors text-left text-gray-400 cursor-not-allowed"
      >
        <Copy size={16} />
        <span>复制任务</span>
      </button>

      <div className="my-1 border-t border-gray-100" />

      <button
        onClick={() => {
          onDelete();
          onClose();
        }}
        className="w-full px-4 py-2 flex items-center gap-3 hover:bg-red-50 text-red-600 transition-colors text-left"
      >
        <Trash2 size={16} />
        <span>删除任务</span>
      </button>
    </div>
  );
};
