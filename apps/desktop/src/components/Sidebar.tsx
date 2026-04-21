import { Calendar, Home, List as ListIcon, Plus, Star, Sun } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { useCreateList, useList } from '@baicie/orbit-hooks';

interface SidebarProps {
  onItemClick?: () => void;
}

export function Sidebar({ onItemClick }: SidebarProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { listId } = useParams();
  const activeListId = listId || 'my-day';
  const [isCreating, setIsCreating] = useState(false);
  const [newListTitle, setNewListTitle] = useState('');

  const { data: lists } = useList();
  const createList = useCreateList();

  const smartLists = [
    { id: 'my-day', icon: Sun, label: t('sidebar.myDay') },
    { id: 'important', icon: Star, label: t('sidebar.important') },
    { id: 'planned', icon: Calendar, label: t('sidebar.planned') },
    { id: 'tasks', icon: Home, label: t('sidebar.tasks') },
  ];

  const handleCreateList = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newListTitle.trim()) return;
    createList.mutate(
      { title: newListTitle },
      {
        onSuccess: (data) => {
          setIsCreating(false);
          setNewListTitle('');
          navigate(`/tasks/${data.id}`);
        },
      },
    );
  };

  return (
    <div className="w-[260px] h-full bg-[var(--sidebar-bg)] flex flex-col border-r border-gray-200 pt-2">
      <div className="flex-1 overflow-y-auto py-2">
        <div className="space-y-0.5">
          {smartLists.map((item) => (
            <div
              key={item.id}
              onClick={() => {
                navigate(`/tasks/${item.id}`);
                onItemClick?.();
              }}
              className={`px-4 py-2.5 flex items-center gap-3 cursor-pointer transition-colors relative ${
                activeListId === item.id
                  ? 'bg-blue-50 text-[var(--theme-primary)]'
                  : 'text-gray-700 hover:bg-[var(--sidebar-hover)]'
              }`}
            >
              {activeListId === item.id && (
                <motion.div
                  layoutId="activeIndicator"
                  className="absolute left-0 top-0 bottom-0 w-[3px] bg-[var(--theme-primary)]"
                  transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                />
              )}
              <item.icon size={20} strokeWidth={1.5} />
              <span className="flex-1 text-sm">{item.label}</span>
            </div>
          ))}
        </div>

        <div className="my-3 border-t border-gray-200 mx-4" />

        <div className="space-y-0.5">
          {lists?.map((list) => (
            <div
              key={list.id}
              onClick={() => {
                navigate(`/tasks/${list.id}`);
                onItemClick?.();
              }}
              className={`px-4 py-2.5 flex items-center gap-3 cursor-pointer transition-colors relative ${
                activeListId === list.id
                  ? 'bg-blue-50 text-[var(--theme-primary)]'
                  : 'text-gray-700 hover:bg-[var(--sidebar-hover)]'
              }`}
            >
              {activeListId === list.id && (
                <motion.div
                  layoutId="activeIndicator"
                  className="absolute left-0 top-0 bottom-0 w-[3px] bg-[var(--theme-primary)]"
                  transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                />
              )}
              <ListIcon size={20} strokeWidth={1.5} />
              <span className="flex-1 text-sm">{list.title}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="p-3">
        {isCreating ? (
          <form onSubmit={handleCreateList} className="w-full">
            <input
              type="text"
              value={newListTitle}
              onChange={(e) => setNewListTitle(e.target.value)}
              placeholder={t('sidebar.newList')}
              autoFocus
              className="w-full px-3 py-2 border border-[var(--theme-primary)] rounded focus:outline-none text-sm bg-white text-gray-900"
              onBlur={() => {
                if (!newListTitle.trim()) setIsCreating(false);
              }}
            />
          </form>
        ) : (
          <button
            onClick={() => setIsCreating(true)}
            className="w-full flex items-center gap-2 px-3 py-2 text-[var(--theme-primary)] hover:bg-[var(--sidebar-hover)] rounded transition-colors"
          >
            <Plus size={20} />
            <span className="text-sm font-medium">{t('sidebar.createList')}</span>
          </button>
        )}
      </div>
    </div>
  );
}
