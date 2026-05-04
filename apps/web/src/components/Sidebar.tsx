import {
  Calendar,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  Home,
  List as ListIcon,
  Plus,
  Star,
  Sun,
  Trash2,
} from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import {
  useCreateGroup,
  useCreateList,
  useCreateTag,
  useDeleteGroup,
  useGroup,
  useList,
  useTag,
} from '@baicie/orbit-hooks';
import { useState } from 'react';
import type { Group, List } from '@baicie/orbit';
import { useTagsEnabled } from '../hooks/useTagsEnabled';
import { Button, Input } from '@baicie/orbit-ui';

export const Sidebar = ({ onItemClick }: { onItemClick?: () => void }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { listId } = useParams();
  const activeListId = listId || 'my-day';
  const [isCreating, setIsCreating] = useState(false);
  const [newListTitle, setNewListTitle] = useState('');
  const [isCreatingTag, setIsCreatingTag] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [isTagsExpanded, setIsTagsExpanded] = useState(true);
  const [isCreatingGroup, setIsCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const tagsEnabled = useTagsEnabled();

  const { data: lists = [] } = useList();
  const { data: allTags = [] } = useTag();
  const { data: allGroups = [] } = useGroup();
  const createListMutation = useCreateList();
  const createTagMutation = useCreateTag();
  const createGroupMutation = useCreateGroup();
  const deleteGroupMutation = useDeleteGroup();

  const handleCreateList = (e: React.FormEvent, groupId?: string) => {
    e.preventDefault();
    if (!newListTitle.trim()) return;
    createListMutation.mutate(
      { title: newListTitle, groupId },
      {
        onSuccess: (newList) => {
          setIsCreating(false);
          setNewListTitle('');
          navigate(`/tasks/${newList.id}`);
          if (onItemClick) onItemClick();
        },
      },
    );
  };

  const handleCreateTag = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTagName.trim()) return;
    createTagMutation.mutate(
      { name: newTagName.trim(), color: '#6366f1' },
      {
        onSuccess: () => {
          setIsCreatingTag(false);
          setNewTagName('');
        },
      },
    );
  };

  const handleCreateGroup = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newGroupName.trim()) return;
    createGroupMutation.mutate(
      { name: newGroupName.trim(), color: '#6366f1' },
      {
        onSuccess: () => {
          setIsCreatingGroup(false);
          setNewGroupName('');
        },
      },
    );
  };

  const toggleGroup = (groupId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  const smartLists = [
    { id: 'my-day', icon: Sun, label: t('sidebar.myDay') },
    { id: 'important', icon: Star, label: t('sidebar.important') },
    { id: 'planned', icon: Calendar, label: t('sidebar.planned') },
    { id: 'tasks', icon: Home, label: t('sidebar.tasks') },
  ];

  // Get lists without a group
  const ungroupedLists = lists.filter((list: List) => !list.groupId);

  // Group lists by their group
  const groupedListsMap = new Map<string, List[]>();
  lists.forEach((list: List) => {
    if (list.groupId) {
      const existing = groupedListsMap.get(list.groupId) || [];
      groupedListsMap.set(list.groupId, [...existing, list]);
    }
  });

  const renderListItem = (list: List, indent: boolean = false) => (
    <div
      key={list.id}
      onClick={() => {
        navigate(`/tasks/${list.id}`);
        if (onItemClick) onItemClick();
      }}
      className={`flex items-center gap-3 cursor-pointer transition-colors relative ${
        indent ? 'pl-10' : ''
      } ${
        activeListId === list.id
          ? 'bg-blue-50 text-[var(--theme-primary)]'
          : 'text-gray-700 hover:bg-[var(--sidebar-hover)]'
      }`}
      style={{ padding: '10px 16px' }}
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
  );

  return (
    <div className="w-[280px] h-full bg-[var(--sidebar-bg)] flex flex-col border-r border-gray-200 pt-2">
      {/* Smart Lists */}
      <div className="flex-1 overflow-y-auto py-2">
        <div className="space-y-0">
          {smartLists.map((item) => (
            <div
              key={item.id}
              onClick={() => {
                navigate(`/tasks/${item.id}`);
                if (onItemClick) onItemClick();
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

        {/* Custom Lists */}
        <div className="space-y-0">
          {ungroupedLists.map((list: List) => renderListItem(list))}

          {/* Groups with their lists */}
          {allGroups.map((group: Group) => {
            const groupLists = groupedListsMap.get(group.id) || [];
            const isExpanded = expandedGroups.has(group.id);

            return (
              <div key={group.id}>
                <div className="flex items-center group">
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleGroup(group.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') toggleGroup(group.id);
                    }}
                    className="px-4 py-2 flex items-center gap-2 cursor-pointer transition-colors w-full hover:bg-[var(--sidebar-hover)]"
                  >
                    {isExpanded ? (
                      <ChevronDown size={14} className="text-gray-400" />
                    ) : (
                      <ChevronRight size={14} className="text-gray-400" />
                    )}
                    <span
                      className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                      style={{ backgroundColor: group.color }}
                    />
                    <span className="flex-1 text-sm font-medium text-gray-700 truncate">
                      {group.name}
                    </span>
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`删除分组「${group.name}」？清单不会被删除。`)) {
                          deleteGroupMutation.mutate(group.id);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.stopPropagation();
                          if (confirm(`删除分组「${group.name}」？清单不会被删除。`)) {
                            deleteGroupMutation.mutate(group.id);
                          }
                        }
                      }}
                      className="opacity-0 group-hover:opacity-100 p-1 hover:bg-gray-200 rounded transition-opacity cursor-pointer"
                    >
                      <Trash2 size={12} className="text-gray-400 hover:text-red-500" />
                    </div>
                  </div>
                </div>

                <AnimatePresence>
                  {isExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="overflow-hidden"
                    >
                      {groupLists.map((list: List) => renderListItem(list, true))}
                      <div
                        onClick={() => toggleGroup(group.id)}
                        className="pl-10 pr-4 py-2 flex items-center gap-2 cursor-pointer text-gray-400 hover:text-gray-600 transition-colors text-sm"
                      >
                        <Plus size={14} />
                        <span>添加清单</span>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}

          {/* Create Group Button */}
          <div className="px-4 py-1.5">
            {isCreatingGroup ? (
              <form onSubmit={handleCreateGroup} className="w-full flex items-center gap-2">
                <Input
                  type="text"
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  placeholder="分组名称"
                  autoFocus
                  className="flex-1"
                  onBlur={() => {
                    if (!newGroupName.trim()) setIsCreatingGroup(false);
                  }}
                />
              </form>
            ) : (
              <Button
                onClick={() => setIsCreatingGroup(true)}
                variant="ghost"
                className="w-full justify-start text-gray-500 hover:text-gray-700"
              >
                <FolderPlus size={14} />
                <span>添加分组</span>
              </Button>
            )}
          </div>
        </div>

        {/* Tags Section */}
        {tagsEnabled && allTags.length > 0 && (
          <>
            <div className="my-3 border-t border-gray-200 mx-4" />
            <Button
              onClick={() => setIsTagsExpanded(!isTagsExpanded)}
              variant="ghost"
              className="w-full justify-between px-4 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider"
            >
              <span>标签</span>
              <span className={`transition-transform ${isTagsExpanded ? 'rotate-90' : ''}`}>
                <ChevronRight size={14} />
              </span>
            </Button>
            {isTagsExpanded && (
              <div className="space-y-0">
                {allTags.map((tag) => (
                  <div
                    key={tag.id}
                    onClick={() => {
                      navigate(`/tasks/tag:${tag.id}`);
                      if (onItemClick) onItemClick();
                    }}
                    className={`px-4 py-2 flex items-center gap-3 cursor-pointer transition-colors relative ${
                      activeListId === `tag:${tag.id}`
                        ? 'bg-blue-50 text-[var(--theme-primary)]'
                        : 'text-gray-700 hover:bg-[var(--sidebar-hover)]'
                    }`}
                  >
                    {activeListId === `tag:${tag.id}` && (
                      <motion.div
                        layoutId="activeTagIndicator"
                        className="absolute left-0 top-0 bottom-0 w-[3px] bg-[var(--theme-primary)]"
                        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                      />
                    )}
                    <span
                      className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                      style={{ backgroundColor: tag.color }}
                    />
                    <span className="flex-1 text-sm truncate">{tag.name}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* New Tag Button */}
        {tagsEnabled && (
          <div className="px-4 py-1.5">
            {isCreatingTag ? (
              <form onSubmit={handleCreateTag} className="w-full flex items-center gap-2">
                <Input
                  type="text"
                  value={newTagName}
                  onChange={(e) => setNewTagName(e.target.value)}
                  placeholder="标签名称"
                  autoFocus
                  className="flex-1"
                  onBlur={() => {
                    if (!newTagName.trim()) setIsCreatingTag(false);
                  }}
                />
              </form>
            ) : (
              <Button
                onClick={() => setIsCreatingTag(true)}
                variant="ghost"
                className="w-full justify-start text-gray-500 hover:text-gray-700"
              >
                <Plus size={14} />
                <span>添加标签</span>
              </Button>
            )}
          </div>
        )}
      </div>

      {/* New List Button */}
      <div className="p-3">
        {isCreating ? (
          <form onSubmit={(e) => handleCreateList(e)} className="w-full">
            <Input
              type="text"
              value={newListTitle}
              onChange={(e) => setNewListTitle(e.target.value)}
              placeholder={t('sidebar.newList')}
              autoFocus
              className="w-full"
              onBlur={() => {
                if (!newListTitle.trim()) setIsCreating(false);
              }}
            />
          </form>
        ) : (
          <Button
            onClick={() => setIsCreating(true)}
            variant="ghost"
            className="w-full justify-start text-[var(--theme-primary)] hover:bg-[var(--sidebar-hover)]"
          >
            <Plus size={20} />
            <span className="text-sm font-medium">{t('sidebar.createList')}</span>
          </Button>
        )}
      </div>
    </div>
  );
};
