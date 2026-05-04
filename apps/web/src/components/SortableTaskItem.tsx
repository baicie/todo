import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Task } from '@baicie/orbit';
import { Calendar, Check, Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Input } from '@baicie/orbit-ui';

interface SortableTaskItemProps {
  task: Task;
  isSelected: boolean;
  focusedIndex: number;
  activeIndex: number;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent, task: Task) => void;
  onToggleComplete: (task: Task) => void;
  onToggleImportant: (task: Task) => void;
  onDateChange: (task: Task, dateStr: string | null) => void;
  viewMode: 'list' | 'table';
}

export function SortableTaskItem({
  task,
  isSelected,
  focusedIndex,
  activeIndex,
  onSelect,
  onContextMenu,
  onToggleComplete,
  onToggleImportant,
  onDateChange,
  viewMode,
}: SortableTaskItemProps) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 1000 : 'auto',
  };

  const getDueDateText = (dateStr?: string | null) => {
    if (!dateStr) return { text: '-', isOverdue: false };
    const date = new Date(dateStr);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const isToday = date.toDateString() === today.toDateString();
    const isYesterday = date.toDateString() === yesterday.toDateString();
    const isTomorrow = date.toDateString() === tomorrow.toDateString();
    const isOverdue = date < today && !isToday;

    let text = date.toLocaleDateString();
    if (isToday) text = '今天';
    if (isYesterday) text = '昨天';
    if (isTomorrow) text = '明天';

    return { text, isOverdue };
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group bg-white rounded-md shadow-sm border p-3 flex items-center gap-3 hover:bg-gray-50 transition-colors ${
        isSelected ? 'bg-blue-50 border-blue-200' : 'border-gray-100'
      } ${viewMode === 'table' ? 'grid grid-cols-12 gap-4 !items-center' : ''} ${
        focusedIndex >= 0 && activeIndex >= 0 && activeIndex === focusedIndex
          ? 'ring-2 ring-[var(--theme-primary)] ring-offset-1'
          : ''
      } ${isDragging ? 'opacity-50 shadow-lg ring-2 ring-blue-200' : ''}`}
      onClick={onSelect}
      onContextMenu={(e) => onContextMenu(e, task)}
      {...attributes}
      {...listeners}
    >
      <div className={`flex items-center gap-3 ${viewMode === 'table' ? 'col-span-5' : ''}`}>
        <Button
          variant="ghost"
          size="icon"
          onClick={(e) => {
            e.stopPropagation();
            onToggleComplete(task);
          }}
          className="w-5 h-5 rounded-full border-2 border-gray-400 hover:border-[var(--theme-primary)] flex items-center justify-center transition-colors flex-shrink-0 p-0"
        >
          {task.isCompleted ? (
            <div className="w-full h-full rounded-full bg-[var(--theme-primary)] flex items-center justify-center">
              <Check size={12} className="text-white" strokeWidth={3} />
            </div>
          ) : null}
        </Button>
        <span className="flex-1 text-sm text-gray-900 break-words line-clamp-2">
          <div className="flex flex-col">
            <span className={task.isCompleted ? 'line-through text-gray-400' : ''}>
              {task.title}
            </span>
            {task.steps && task.steps.length > 0 && (
              <span className="text-xs text-gray-500">
                {t('main.stepProgress', {
                  completed: task.steps.filter((s) => s.isCompleted).length,
                  total: task.steps.length,
                })}
              </span>
            )}
          </div>
        </span>
      </div>

      {viewMode === 'table' ? (
        <>
          <div className="col-span-3 text-sm relative group/date">
            {(() => {
              const { text, isOverdue } = getDueDateText(task.dueDate);
              return (
                <div
                  className={`flex items-center gap-2 cursor-pointer ${
                    isOverdue ? 'text-red-500' : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {task.dueDate && <Calendar size={14} />}
                  <span>{text}</span>
                  <Input
                    type="date"
                    className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                    value={task.dueDate ? new Date(task.dueDate).toISOString().split('T')[0] : ''}
                    onChange={(e) => {
                      const date = e.target.value ? new Date(e.target.value).toISOString() : null;
                      onDateChange(task, date);
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                </div>
              );
            })()}
          </div>
          <div className="col-span-3 flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={(e) => {
                e.stopPropagation();
                onToggleImportant(task);
              }}
              className={`p-1.5 flex-shrink-0 ${
                task.isImportant ? 'text-[var(--theme-primary)]' : 'text-gray-400'
              }`}
            >
              <Star size={18} fill={task.isImportant ? 'currentColor' : 'none'} />
            </Button>
          </div>
        </>
      ) : (
        <Button
          variant="ghost"
          size="icon"
          onClick={(e) => {
            e.stopPropagation();
            onToggleImportant(task);
          }}
          className={`p-1.5 flex-shrink-0 ${
            task.isImportant ? 'text-[var(--theme-primary)]' : 'text-gray-400'
          }`}
        >
          <Star size={18} fill={task.isImportant ? 'currentColor' : 'none'} />
        </Button>
      )}
    </div>
  );
}
