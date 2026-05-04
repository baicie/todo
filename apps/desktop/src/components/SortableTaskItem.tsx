import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Task } from '@baicie/orbit';
import { Check, GripVertical, Star } from 'lucide-react';

interface SortableTaskItemProps {
  task: Task;
  isSelected: boolean;
  isChecked: boolean;
  onSelect: () => void;
  onToggleCheck: (e: React.MouseEvent) => void;
  onToggleComplete: (task: Task) => void;
  onToggleImportant: (task: Task) => void;
  viewMode: 'list' | 'table';
}

export function SortableTaskItem({
  task,
  isSelected,
  isChecked,
  onSelect,
  onToggleCheck,
  onToggleComplete,
  onToggleImportant,
  viewMode,
}: SortableTaskItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group bg-white rounded-md shadow-sm border border-gray-100 p-3 flex items-center gap-3 hover:bg-gray-50 transition-colors cursor-pointer ${
        isSelected ? 'bg-blue-50 border-blue-200' : ''
      } ${viewMode === 'table' ? 'grid grid-cols-12 gap-4 !items-center' : ''}`}
      onClick={onSelect}
    >
      {/* Selection checkbox */}
      <button
        onClick={onToggleCheck}
        className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors flex-shrink-0 ${
          isChecked
            ? 'bg-[var(--theme-primary)] border-[var(--theme-primary)] text-white'
            : 'border-gray-300 hover:border-[var(--theme-primary)]'
        }`}
      >
        {isChecked && <Check size={12} strokeWidth={3} />}
      </button>

      <div className={`flex items-center gap-3 ${viewMode === 'table' ? 'col-span-5' : ''}`}>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleComplete(task);
          }}
          className="w-5 h-5 rounded-full border-2 border-gray-400 hover:border-[var(--theme-primary)] flex items-center justify-center transition-colors flex-shrink-0"
        >
          {task.isCompleted && (
            <div className="w-full h-full rounded-full bg-[var(--theme-primary)] flex items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                className="w-3 h-3 text-white"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
          )}
        </button>
        <span className="flex-1 text-sm text-gray-900 break-words line-clamp-2">{task.title}</span>
      </div>

      {viewMode === 'table' ? (
        <>
          <div className="col-span-3 text-sm text-gray-500">
            {task.dueDate ? new Date(task.dueDate).toLocaleDateString() : '-'}
          </div>
          <div className="col-span-3">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleImportant(task);
              }}
              className={`p-1.5 rounded hover:bg-gray-100 ${task.isImportant ? 'text-[var(--theme-primary)]' : 'text-gray-400'}`}
            >
              <Star size={18} fill={task.isImportant ? 'currentColor' : 'none'} />
            </button>
          </div>
        </>
      ) : (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleImportant(task);
          }}
          className={`p-1.5 rounded hover:bg-gray-100 flex-shrink-0 ${
            task.isImportant ? 'text-[var(--theme-primary)]' : 'text-gray-400'
          }`}
        >
          <Star size={18} fill={task.isImportant ? 'currentColor' : 'none'} />
        </button>
      )}

      <button
        {...attributes}
        {...listeners}
        className="p-1 text-gray-300 hover:text-gray-500 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
        onClick={(e) => e.stopPropagation()}
      >
        <GripVertical size={16} />
      </button>
    </div>
  );
}
