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
  onSelectTask: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, task: Task) => void;
  onToggleComplete: (task: Task) => void;
  onToggleImportant: (task: Task) => void;
  onDateChange: (task: Task, dateStr: string | null) => void;
  onReorder: (activeId: string, overId: string) => void;
  viewMode: 'list' | 'table';
  focusedIndex: number;
}

export function SortableTaskList({
  tasks,
  activeTaskId,
  onSelectTask,
  onContextMenu,
  onToggleComplete,
  onToggleImportant,
  onDateChange,
  onReorder,
  viewMode,
  focusedIndex,
}: SortableTaskListProps) {
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        delay: 250,
        tolerance: 5,
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
      onReorder(active.id as string, over.id as string);
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
                focusedIndex={focusedIndex}
                activeIndex={tasks.findIndex((t) => t.id === activeId)}
                onSelect={() => onSelectTask(task.id)}
                onContextMenu={onContextMenu}
                onToggleComplete={onToggleComplete}
                onToggleImportant={onToggleImportant}
                onDateChange={onDateChange}
                viewMode={viewMode}
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </SortableContext>
    </DndContext>
  );
}
