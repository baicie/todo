import {
  Bell,
  Calendar,
  Check,
  Circle,
  File as FileIcon,
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
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import {
  useAddStep,
  useDeleteStep,
  useDeleteTask,
  useToggleComplete,
  useToggleImportant,
  useToggleMyDay,
  useUpdateStep,
  useUpdateTask,
} from '@baicie/orbit-hooks';
import type { Task, TaskCategory } from '@baicie/orbit';

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
  const [isRepeatMenuOpen, setIsRepeatMenuOpen] = useState(false);
  const [isRemindMenuOpen, setIsRemindMenuOpen] = useState(false);
  const [isDueDateMenuOpen, setIsDueDateMenuOpen] = useState(false);
  const [isCategoryMenuOpen, setIsCategoryMenuOpen] = useState(false);

  const updateTask = useUpdateTask();
  const addStep = useAddStep();
  const updateStep = useUpdateStep();
  const deleteStep = useDeleteStep();
  const deleteTask = useDeleteTask();
  const toggleComplete = useToggleComplete();
  const toggleImportant = useToggleImportant();
  const toggleMyDay = useToggleMyDay();

  const handleTitleBlur = () => {
    if (title !== task.title) {
      updateTask.mutate({ id: task.id, input: { title } });
    }
  };

  const handleDescriptionBlur = () => {
    if (description !== (task.description || '')) {
      updateTask.mutate({ id: task.id, input: { description } });
    }
  };

  const handleAddStep = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newStep.trim()) return;
    addStep.mutate({ taskId: task.id, input: { title: newStep } });
    setNewStep('');
  };

  const handleStepTitleBlur = () => {
    if (editingStepId && editingStepTitle.trim()) {
      updateStep.mutate({ stepId: editingStepId, input: { title: editingStepTitle } });
    }
    setEditingStepId(null);
  };

  const handleStepTitleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleStepTitleBlur();
  };

  const startEditingStep = (step: { id: string; title: string }) => {
    setEditingStepId(step.id);
    setEditingStepTitle(step.title);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const newFile = {
      id: crypto.randomUUID(),
      filename: file.name,
      originalname: file.name,
      mimetype: file.type,
      size: file.size,
      path: URL.createObjectURL(file),
    };
    updateTask.mutate({ id: task.id, input: { files: [...task.files, newFile] } });
  };

  const removeFile = (index: number) => {
    const updatedFiles = [...task.files];
    updatedFiles.splice(index, 1);
    updateTask.mutate({ id: task.id, input: { files: updatedFiles } });
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

  const getRepeatText = (pattern?: string | null) => {
    switch (pattern) {
      case 'daily':
        return '每天';
      case 'weekly':
        return '每周';
      case 'monthly':
        return '每月';
      case 'yearly':
        return '每年';
      default:
        return t('drawer.repeat');
    }
  };

  const getCategoryText = (category?: string | null) => {
    switch (category) {
      case 'blue':
        return '蓝色类别';
      case 'red':
        return '红色类别';
      case 'green':
        return '绿色类别';
      case 'orange':
        return '橙色类别';
      default:
        return t('drawer.pickCategory');
    }
  };

  const updateField = (updates: Parameters<typeof updateTask.mutate>[0]['input']) => {
    updateTask.mutate({ id: task.id, input: updates });
  };

  const categories: { value: TaskCategory; label: string; color: string }[] = [
    { value: 'blue', label: '蓝色类别', color: 'bg-blue-500' },
    { value: 'red', label: '红色类别', color: 'bg-red-500' },
    { value: 'green', label: '绿色类别', color: 'bg-green-500' },
    { value: 'orange', label: '橙色类别', color: 'bg-orange-500' },
  ];

  return (
    <>
      <div className="px-4 pt-4 z-10 bg-[#faf9f8]">
        <div className="bg-white rounded-md shadow-sm p-4">
          <div className="flex items-start gap-3">
            <button
              onClick={() => toggleComplete(task)}
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
              onClick={() => toggleImportant(task)}
              className={`p-1 rounded hover:bg-gray-100 transition-colors ${
                task.isImportant ? 'text-[var(--theme-primary)]' : 'text-gray-400'
              }`}
            >
              <Star size={24} fill={task.isImportant ? 'currentColor' : 'none'} />
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-gray-300 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-track]:bg-transparent">
        <div className="space-y-4">
          <div className="bg-white rounded-md shadow-sm p-4">
            <div>
              {task.steps
                ?.sort(
                  (a: { createdAt: string }, b: { createdAt: string }) =>
                    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
                )
                .map((step: { id: string; title: string; isCompleted: boolean }) => (
                  <div
                    key={step.id}
                    className={`flex items-center gap-3 group px-2 py-2 border-b border-gray-100 last:border-b-0 hover:bg-gray-100 ${
                      editingStepId === step.id ? 'bg-gray-100' : ''
                    }`}
                  >
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        updateStep.mutate({
                          stepId: step.id,
                          input: { isCompleted: !step.isCompleted },
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

          <div className="bg-white rounded-md shadow-sm overflow-hidden">
            <button
              onClick={() => toggleMyDay(task)}
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
                    updateField({ addToMyDay: false });
                  }}
                />
              )}
            </button>
          </div>

          <div className="bg-white rounded-md shadow-sm">
            <div className="relative">
              <button
                onClick={() => setIsRemindMenuOpen(!isRemindMenuOpen)}
                className="flex items-center gap-3 w-full p-4 text-sm text-gray-600 hover:bg-gray-50 transition-colors border-b border-gray-100"
              >
                <Bell size={18} />
                <span>
                  {task.reminderDate
                    ? new Date(task.reminderDate).toLocaleString()
                    : t('drawer.remindMe')}
                </span>
                {task.reminderDate && (
                  <div
                    className="ml-auto p-1 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-200 z-10"
                    onClick={(e) => {
                      e.stopPropagation();
                      updateField({ reminderDate: null });
                    }}
                  >
                    <X size={16} />
                  </div>
                )}
              </button>
              <AnimatePresence>
                {isRemindMenuOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-20"
                      onClick={() => setIsRemindMenuOpen(false)}
                    />
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 10 }}
                      className="absolute left-4 right-4 top-full z-30 bg-white rounded-md shadow-lg border border-gray-100 py-1"
                    >
                      {[
                        {
                          label: '今日晚些时候',
                          getDate: () => {
                            const d = new Date();
                            d.setHours(20, 0, 0, 0);
                            return d;
                          },
                        },
                        {
                          label: '明天',
                          getDate: () => {
                            const d = new Date();
                            d.setDate(d.getDate() + 1);
                            d.setHours(9, 0, 0, 0);
                            return d;
                          },
                        },
                        {
                          label: '下周',
                          getDate: () => {
                            const d = new Date();
                            d.setDate(d.getDate() + ((1 + 7 - d.getDay()) % 7 || 7));
                            d.setHours(9, 0, 0, 0);
                            return d;
                          },
                        },
                      ].map((option, index) => (
                        <button
                          key={index}
                          onClick={() => {
                            updateField({ reminderDate: option.getDate().toISOString() });
                            setIsRemindMenuOpen(false);
                          }}
                          className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50 transition-colors flex items-center justify-between text-gray-700"
                        >
                          <div className="flex items-center gap-2">
                            <Repeat size={16} className="text-gray-400" />
                            <span>{option.label}</span>
                          </div>
                        </button>
                      ))}
                      <div className="border-t border-gray-100 my-1" />
                      <div className="relative">
                        <button className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50 transition-colors flex items-center gap-2 text-gray-700">
                          <Calendar size={16} className="text-gray-400" />
                          <span>选择日期和时间</span>
                        </button>
                        <input
                          type="datetime-local"
                          className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                          onChange={(e) => {
                            const date = e.target.value
                              ? new Date(e.target.value).toISOString()
                              : null;
                            updateField({ reminderDate: date });
                            setIsRemindMenuOpen(false);
                          }}
                        />
                      </div>
                    </motion.div>
                  </>
                )}
              </AnimatePresence>
            </div>

            <div className="relative">
              <button
                onClick={() => setIsDueDateMenuOpen(!isDueDateMenuOpen)}
                className="flex items-center gap-3 w-full p-4 text-sm text-gray-600 hover:bg-gray-50 transition-colors border-b border-gray-100"
              >
                <Calendar size={18} />
                {(() => {
                  const { text, isOverdue } = getDueDateText(task.dueDate);
                  return <span className={isOverdue ? 'text-red-500' : ''}>{text}</span>;
                })()}
                {task.dueDate && (
                  <div
                    className="ml-auto p-1 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-200 z-10"
                    onClick={(e) => {
                      e.stopPropagation();
                      updateField({ dueDate: null });
                    }}
                  >
                    <X size={16} />
                  </div>
                )}
              </button>
              <AnimatePresence>
                {isDueDateMenuOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-20"
                      onClick={() => setIsDueDateMenuOpen(false)}
                    />
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 10 }}
                      className="absolute left-4 right-4 top-full z-30 bg-white rounded-md shadow-lg border border-gray-100 py-1"
                    >
                      {[
                        { label: '今天', getDate: () => new Date() },
                        {
                          label: '明天',
                          getDate: () => {
                            const d = new Date();
                            d.setDate(d.getDate() + 1);
                            return d;
                          },
                        },
                        {
                          label: '下周',
                          getDate: () => {
                            const d = new Date();
                            d.setDate(d.getDate() + ((1 + 7 - d.getDay()) % 7 || 7));
                            return d;
                          },
                        },
                      ].map((option) => (
                        <button
                          key={option.label}
                          onClick={() => {
                            updateField({ dueDate: option.getDate().toISOString() });
                            setIsDueDateMenuOpen(false);
                          }}
                          className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50 transition-colors flex items-center justify-between text-gray-700"
                        >
                          <div className="flex items-center gap-2">
                            <Calendar size={16} className="text-gray-400" />
                            <span>{option.label}</span>
                          </div>
                        </button>
                      ))}
                      <div className="border-t border-gray-100 my-1" />
                      <div className="relative">
                        <button className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50 transition-colors flex items-center gap-2 text-gray-700">
                          <Calendar size={16} className="text-gray-400" />
                          <span>选择日期</span>
                        </button>
                        <input
                          type="date"
                          className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                          onChange={(e) => {
                            const date = e.target.value
                              ? new Date(e.target.value).toISOString()
                              : null;
                            updateField({ dueDate: date });
                            setIsDueDateMenuOpen(false);
                          }}
                        />
                      </div>
                    </motion.div>
                  </>
                )}
              </AnimatePresence>
            </div>
            <div className="relative">
              <button
                onClick={() => setIsRepeatMenuOpen(!isRepeatMenuOpen)}
                className="flex items-center gap-3 w-full p-4 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
              >
                <Repeat size={18} />
                <span>{getRepeatText(task.repeatPattern)}</span>
                {task.repeatPattern && (
                  <div
                    className="ml-auto p-1 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-200 z-10"
                    onClick={(e) => {
                      e.stopPropagation();
                      updateField({ repeatPattern: null });
                    }}
                  >
                    <X size={16} />
                  </div>
                )}
              </button>
              <AnimatePresence>
                {isRepeatMenuOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-20"
                      onClick={() => setIsRepeatMenuOpen(false)}
                    />
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 10 }}
                      className="absolute left-4 right-4 top-full z-30 bg-white rounded-md shadow-lg border border-gray-100 py-1"
                    >
                      {(['daily', 'weekly', 'monthly', 'yearly'] as const).map((value) => (
                        <button
                          key={value}
                          onClick={() => {
                            updateField({ repeatPattern: value });
                            setIsRepeatMenuOpen(false);
                          }}
                          className={`w-full text-left px-4 py-2 text-sm hover:bg-gray-50 transition-colors flex items-center justify-between ${
                            task.repeatPattern === value
                              ? 'text-[var(--theme-primary)] bg-blue-50'
                              : 'text-gray-700'
                          }`}
                        >
                          <span>{getRepeatText(value)}</span>
                          {task.repeatPattern === value && <Check size={16} />}
                        </button>
                      ))}
                    </motion.div>
                  </>
                )}
              </AnimatePresence>
            </div>
          </div>

          <div className="bg-white rounded-md shadow-sm">
            <div className="relative">
              <button
                onClick={() => setIsCategoryMenuOpen(!isCategoryMenuOpen)}
                className="flex items-center gap-3 w-full p-4 text-sm text-gray-600 hover:bg-gray-50 transition-colors border-b border-gray-100"
              >
                <Tag size={18} />
                <span>{getCategoryText(task.category)}</span>
                {task.category && (
                  <div
                    className="ml-auto p-1 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-200 z-10"
                    onClick={(e) => {
                      e.stopPropagation();
                      updateField({ category: null });
                    }}
                  >
                    <X size={16} />
                  </div>
                )}
              </button>
              <AnimatePresence>
                {isCategoryMenuOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-20"
                      onClick={() => setIsCategoryMenuOpen(false)}
                    />
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 10 }}
                      className="absolute left-4 right-4 top-full z-30 bg-white rounded-md shadow-lg border border-gray-100 py-1"
                    >
                      {categories.map((option) => (
                        <button
                          key={option.value}
                          onClick={() => {
                            updateField({ category: option.value });
                            setIsCategoryMenuOpen(false);
                          }}
                          className={`w-full text-left px-4 py-2 text-sm hover:bg-gray-50 transition-colors flex items-center justify-between ${
                            task.category === option.value
                              ? 'text-[var(--theme-primary)] bg-blue-50'
                              : 'text-gray-700'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <div className={`w-2 h-2 rounded-full ${option.color}`} />
                            <span>{option.label}</span>
                          </div>
                          {task.category === option.value && <Check size={16} />}
                        </button>
                      ))}
                    </motion.div>
                  </>
                )}
              </AnimatePresence>
            </div>
            <button className="flex items-center gap-3 w-full p-4 text-sm text-gray-600 hover:bg-gray-50 transition-colors relative">
              <Paperclip size={18} />
              <span>{t('drawer.addFile')}</span>
              <input
                type="file"
                className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                onChange={handleFileUpload}
              />
            </button>
            {task.files && task.files.length > 0 && (
              <div className="px-4 pb-4 space-y-2">
                {task.files.map((file: import('@baicie/orbit').TaskFile, index: number) => (
                  <div
                    key={file.id || index}
                    className="flex items-center justify-between p-2 bg-gray-50 rounded text-sm group"
                  >
                    <div className="flex items-center gap-2 truncate">
                      <FileIcon size={16} className="text-gray-400" />
                      <span className="truncate">{file.originalname}</span>
                    </div>
                    <button
                      onClick={() => removeFile(index)}
                      className="text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <X size={16} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

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
          onClick={() => {
            deleteTask.mutate(task.id);
            onClose();
          }}
          className="p-2 hover:bg-gray-200 rounded transition-colors text-gray-500 hover:text-red-600"
          title={t('drawer.deleteTask')}
        >
          <Trash2 size={18} />
        </button>
      </div>

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
                  onClick={() => {
                    deleteStep.mutate(stepToDelete);
                    setStepToDelete(null);
                  }}
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
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/20 z-20 hidden md:block"
          />
          <motion.div
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 360, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className="fixed md:relative inset-y-0 right-0 w-full md:w-[360px] bg-[#faf9f8] h-full border-l border-gray-200 flex flex-col shadow-xl z-30 min-w-0"
          >
            <TaskDetailContent key={task.id} task={task} onClose={onClose} />
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};
