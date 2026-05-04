import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import type { Task } from '@baicie/orbit';
import { AnimatePresence, motion } from 'framer-motion';
import { useState } from 'react';
import { SortableTaskItem } from './SortableTaskItem';

interface SortableTaskListProps {
  tasks: Task[];
  activeTaskId: string | null;
  isChecked: (id: string) => boolean;
  onSelectTask: (id: string) => void;
  onToggleCheck: (taskId: string) => void;
  onToggleComplete: (task: Task) => void;
  onToggleImportant: (task: Task) => void;
  onReorder: (activeId: string, overId: string) => void;
  viewMode: 'list' | 'table';
}

export function SortableTaskList({
  tasks,
  activeTaskId,
  isChecked,
  onSelectTask,
  onToggleCheck,
  onToggleComplete,
  onToggleImportant,
  onReorder,
  viewMode,
}: SortableTaskListProps) {
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragStart = (event: import('@dnd-kit/core').DragStartEvent) => {
    setActiveId(String(event.active.id));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);

    if (over && active.id !== over.id) {
      onReorder(String(active.id), String(over.id));
    }
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        <AnimatePresence initial={false} mode="popLayout">
          {tasks.map((task) => (
            <motion.div
              key={task.id}
              layout
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ type: 'spring', stiffness: 500, damping: 30 }}
            >
              <SortableTaskItem
                task={task}
                isSelected={activeTaskId === task.id}
                isChecked={isChecked(task.id)}
                onSelect={() => onSelectTask(task.id)}
                onToggleCheck={(e) => {
                  e.stopPropagation();
                  onToggleCheck(task.id);
                }}
                onToggleComplete={onToggleComplete}
                onToggleImportant={onToggleImportant}
                viewMode={viewMode}
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </SortableContext>
    </DndContext>
  );
}
