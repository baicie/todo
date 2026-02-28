import {
  Bell,
  Calendar,
  Check,
  Circle,
  Paperclip,
  Plus,
  Repeat,
  Star,
  Sun,
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';

interface Step {
  id: string;
  title: string;
  isCompleted: boolean;
  createdAt: string;
}

interface Task {
  id: string;
  title: string;
  isCompleted: boolean;
  isImportant: boolean;
  addToMyDay: boolean;
  dueDate?: string | null;
  reminderDate?: string;
  description?: string;
  steps?: Step[];
  createdAt?: string;
}

interface TaskDetailDrawerProps {
  task: Task | null;
  onClose: () => void;
}

interface TaskDetailContentProps {
  task: Task;
  onClose: () => void;
}

const TaskDetailContent = ({ task, onClose }: TaskDetailContentProps) => {
  const { t } = useTranslation();
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description || '');
  const [newStep, setNewStep] = useState('');
  const [editingStepId, setEditingStepId] = useState<string | null>(null);
  const [editingStepTitle, setEditingStepTitle] = useState('');
  const [stepToDelete, setStepToDelete] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const updateTaskMutation = useMutation({
    mutationFn: (updates: Partial<Task>) => {
      return api.patch(`/tasks/${task.id}`, updates);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });

  const addStepMutation = useMutation({
    mutationFn: (title: string) => {
      return api.post(`/tasks/${task.id}/steps`, { title });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      setNewStep('');
    },
  });

  const updateStepMutation = useMutation({
    mutationFn: ({ stepId, updates }: { stepId: string; updates: Partial<Step> }) => {
      return api.patch(`/tasks/steps/${stepId}`, updates);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });

  const deleteStepMutation = useMutation({
    mutationFn: (stepId: string) => {
      return api.delete(`/tasks/steps/${stepId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      setStepToDelete(null);
    },
  });

  const deleteTaskMutation = useMutation({
    mutationFn: () => {
      return api.delete(`/tasks/${task.id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      onClose();
    },
  });

  const handleAddStep = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newStep.trim()) return;
    addStepMutation.mutate(newStep);
  };

  const handleTitleBlur = () => {
    if (task && title !== task.title) {
      updateTaskMutation.mutate({ title });
    }
  };

  const handleDescriptionBlur = () => {
    if (task && description !== (task.description || '')) {
      updateTaskMutation.mutate({ description });
    }
  };

  const handleStepTitleBlur = () => {
    if (editingStepId && editingStepTitle.trim()) {
      updateStepMutation.mutate({
        stepId: editingStepId,
        updates: { title: editingStepTitle },
      });
    }
    setEditingStepId(null);
  };

  const handleStepTitleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleStepTitleBlur();
    }
  };

  const startEditingStep = (step: Step) => {
    setEditingStepId(step.id);
    setEditingStepTitle(step.title);
  };

  const getDueDateText = (dateStr?: string | null) => {
    if (!dateStr) return { text: t('drawer.addDueDate'), isOverdue: false };
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
    <>
      {/* Fixed Header */}
      <div className="px-4 pt-4 z-10 bg-[#faf9f8]">
        <div className="bg-white rounded-md shadow-sm p-4">
          <div className="flex items-start gap-3">
            <button
              onClick={() => updateTaskMutation.mutate({ isCompleted: !task.isCompleted })}
              className="mt-1 text-gray-400 hover:text-[var(--theme-primary)] transition-colors"
            >
              {task.isCompleted ? (
                <div className="w-6 h-6 rounded-full bg-[var(--theme-primary)] flex items-center justify-center">
                  <Check size={16} className="text-white" strokeWidth={3} />
                </div>
              ) : (
                <Circle size={24} />
              )}
            </button>
            <div className="flex-1">
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={handleTitleBlur}
                className={`w-full bg-transparent border-none outline-none text-xl font-bold ${
                  task.isCompleted ? 'text-gray-500 line-through' : 'text-gray-900'
                }`}
              />
            </div>
            <button
              onClick={() => updateTaskMutation.mutate({ isImportant: !task.isImportant })}
              className={`p-1 rounded hover:bg-gray-100 transition-colors ${
                task.isImportant ? 'text-[var(--theme-primary)]' : 'text-gray-400'
              }`}
            >
              <Star size={24} fill={task.isImportant ? 'currentColor' : 'none'} />
            </button>
          </div>
        </div>
      </div>

      {/* Scrollable Content */}
      <div className="flex-1 overflow-y-auto px-4 pb-4 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-gray-300 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-track]:bg-transparent">
        <div className="space-y-4">
          {/* Steps Section */}
          <div className="bg-white rounded-md shadow-sm p-4">
            <div>
              {task.steps
                ?.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
                .map((step) => (
                  <div
                    key={step.id}
                    className={`flex items-center gap-3 group px-2 py-2 border-b border-gray-100 last:border-b-0 hover:bg-gray-100 ${
                      editingStepId === step.id ? 'bg-gray-100' : ''
                    }`}
                  >
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        updateStepMutation.mutate({
                          stepId: step.id,
                          updates: { isCompleted: !step.isCompleted },
                        });
                      }}
                      className="text-gray-400 hover:text-[var(--theme-primary)] transition-colors p-1"
                    >
                      {step.isCompleted ? (
                        <div className="w-[18px] h-[18px] rounded-full bg-[var(--theme-primary)] flex items-center justify-center">
                          <Check size={12} className="text-white" strokeWidth={3} />
                        </div>
                      ) : (
                        <Circle size={18} />
                      )}
                    </button>

                    {editingStepId === step.id ? (
                      <input
                        type="text"
                        value={editingStepTitle}
                        onChange={(e) => setEditingStepTitle(e.target.value)}
                        onBlur={handleStepTitleBlur}
                        onKeyDown={handleStepTitleKeyDown}
                        autoFocus
                        className={`flex-1 bg-transparent border-none outline-none text-sm text-gray-900 ${
                          step.isCompleted ? 'line-through text-gray-500' : ''
                        }`}
                      />
                    ) : (
                      <span
                        onClick={() => startEditingStep(step)}
                        className={`flex-1 text-sm cursor-text ${
                          step.isCompleted ? 'text-gray-500 line-through' : 'text-gray-900'
                        }`}
                      >
                        {step.title}
                      </span>
                    )}

                    <button
                      onClick={() => setStepToDelete(step.id)}
                      className="text-gray-400 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100 p-1"
                    >
                      <X size={16} />
                    </button>
                  </div>
                ))}

              <form
                onSubmit={handleAddStep}
                className="flex items-center gap-3 text-[var(--theme-primary)] hover:text-blue-700 w-full py-1 transition-colors"
              >
                <Plus size={18} />
                <input
                  type="text"
                  value={newStep}
                  onChange={(e) => setNewStep(e.target.value)}
                  placeholder={
                    task.steps && task.steps.length > 0 ? t('drawer.nextStep') : t('drawer.addStep')
                  }
                  className="flex-1 bg-transparent border-none outline-none text-sm placeholder:text-[var(--theme-primary)] text-gray-900"
                />
              </form>
            </div>
          </div>

          {/* Action List */}
          <div className="bg-white rounded-md shadow-sm overflow-hidden">
            <button
              onClick={() => updateTaskMutation.mutate({ addToMyDay: !task.addToMyDay })}
              className={`flex items-center gap-3 w-full p-4 text-sm hover:bg-gray-50 transition-colors ${
                task.addToMyDay ? 'text-blue-600' : 'text-gray-600'
              }`}
            >
              <Sun size={18} />
              <span>{task.addToMyDay ? t('drawer.addedToMyDay') : t('drawer.addToMyDay')}</span>
              {task.addToMyDay && (
                <X
                  size={16}
                  className="ml-auto text-gray-400 hover:text-gray-600"
                  onClick={(e) => {
                    e.stopPropagation();
                    updateTaskMutation.mutate({ addToMyDay: false });
                  }}
                />
              )}
            </button>
          </div>

          <div className="bg-white rounded-md shadow-sm overflow-hidden">
            <button className="flex items-center gap-3 w-full p-4 text-sm text-gray-600 hover:bg-gray-50 transition-colors border-b border-gray-100">
              <Bell size={18} />
              <span>{t('drawer.remindMe')}</span>
            </button>
            <button className="flex items-center gap-3 w-full p-4 text-sm text-gray-600 hover:bg-gray-50 transition-colors border-b border-gray-100 relative">
              <Calendar size={18} />
              {(() => {
                const { text, isOverdue } = getDueDateText(task.dueDate);
                return <span className={isOverdue ? 'text-red-500' : ''}>{text}</span>;
              })()}
              {task.dueDate && (
                <X
                  size={16}
                  className="ml-auto text-gray-400 hover:text-gray-600 z-10"
                  onClick={(e) => {
                    e.stopPropagation();
                    updateTaskMutation.mutate({ dueDate: null }); // Use null instead of undefined
                  }}
                />
              )}
              <input
                type="date"
                className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                value={task.dueDate ? new Date(task.dueDate).toISOString().split('T')[0] : ''}
                onChange={(e) => {
                  const date = e.target.value ? new Date(e.target.value).toISOString() : null;
                  updateTaskMutation.mutate({ dueDate: date });
                }}
              />
            </button>
            <button className="flex items-center gap-3 w-full p-4 text-sm text-gray-600 hover:bg-gray-50 transition-colors">
              <Repeat size={18} />
              <span>{t('drawer.repeat')}</span>
            </button>
          </div>

          <div className="bg-white rounded-md shadow-sm overflow-hidden">
            <button className="flex items-center gap-3 w-full p-4 text-sm text-gray-600 hover:bg-gray-50 transition-colors border-b border-gray-100">
              <Tag size={18} />
              <span>{t('drawer.pickCategory')}</span>
            </button>
            <button className="flex items-center gap-3 w-full p-4 text-sm text-gray-600 hover:bg-gray-50 transition-colors">
              <Paperclip size={18} />
              <span>{t('drawer.addFile')}</span>
            </button>
          </div>

          {/* Description */}
          <div className="bg-white rounded-md shadow-sm p-4">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={handleDescriptionBlur}
              placeholder={t('drawer.addNote')}
              className="w-full min-h-[100px] text-sm text-gray-700 placeholder:text-gray-400 border-none outline-none resize-none bg-transparent"
            />
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="p-3 border-t border-gray-200 bg-[#faf9f8] flex items-center justify-between text-xs text-gray-500">
        <button onClick={onClose} className="p-2 hover:bg-gray-200 rounded transition-colors">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <line x1="15" y1="3" x2="15" y2="21" />
            <path d="m9 9 3 3-3 3" />
          </svg>
        </button>
        <span>
          {t('drawer.created', {
            date: new Date(task.createdAt || new Date()).toLocaleDateString(),
          })}
        </span>
        <button
          onClick={() => deleteTaskMutation.mutate()}
          className="p-2 hover:bg-gray-200 rounded transition-colors text-gray-500 hover:text-red-600"
          title={t('drawer.deleteTask')}
        >
          <Trash2 size={18} />
        </button>
      </div>

      {/* Delete Step Confirmation Dialog */}
      <AnimatePresence>
        {stepToDelete && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setStepToDelete(null)}
              className="fixed inset-0 bg-black/20 z-[60]"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg shadow-xl p-6 z-[70] w-[300px]"
            >
              <h3 className="text-lg font-semibold mb-2">删除步骤？</h3>
              <p className="text-gray-600 text-sm mb-6">确定要删除此步骤吗？此操作无法撤销。</p>
              <div className="flex justify-end gap-3">
                <button
                  onClick={() => setStepToDelete(null)}
                  className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={() => deleteStepMutation.mutate(stepToDelete)}
                  className="px-4 py-2 text-sm text-white bg-red-600 hover:bg-red-700 rounded transition-colors"
                >
                  删除
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
};

export const TaskDetailDrawer = ({ task, onClose }: TaskDetailDrawerProps) => {
  return (
    <AnimatePresence>
      {task && (
        <>
          {/* Backdrop for mobile */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/20 z-20 md:hidden"
          />
          <motion.div
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 360, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className="fixed md:static inset-y-0 right-0 w-full md:w-[360px] bg-[#faf9f8] h-full border-l border-gray-200 flex flex-col shadow-xl z-30 md:z-20 min-w-0"
          >
            <TaskDetailContent key={task.id} task={task} onClose={onClose} />
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};
