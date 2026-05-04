import {
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Group, List } from '@baicie/orbit';
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
import { useState } from 'react';
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
  useUpdateGroup,
  useUpdateList,
} from '@baicie/orbit-hooks';
import { useTagsEnabled } from '../hooks/useTagsEnabled';
import { Button, Input } from '@baicie/orbit-ui';

const smartLists = [
  { id: 'my-day', icon: Sun, label: '我的一天' },
  { id: 'important', icon: Star, label: '重要' },
  { id: 'planned', icon: Calendar, label: '计划' },
  { id: 'tasks', icon: Home, label: '所有任务' },
];

interface SortableListItemProps {
  list: List;
  activeListId: string;
  onItemClick?: () => void;
  isDropTarget?: boolean;
  draggingTask: { id: string } | null;
  onTaskDrop?: (taskId: string, listId: string) => void;
  overTargetId: string | null;
  setOverTargetId: (id: string | null) => void;
  indent?: boolean;
}

function SortableListItem({
  list,
  activeListId,
  onItemClick,
  isDropTarget,
  draggingTask,
  onTaskDrop,
  overTargetId,
  setOverTargetId,
  indent = false,
}: SortableListItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `list-${list.id}`,
    data: { type: 'list', list },
  });

  const navigate = useNavigate();

  return (
    <div
      ref={setNodeRef}
      className={`flex items-center gap-3 transition-colors relative ${indent ? 'pl-10' : ''} ${
        isDropTarget ? 'ring-2 ring-blue-400 ring-inset bg-blue-50' : ''
      } ${
        activeListId === list.id
          ? 'bg-blue-50 text-[var(--theme-primary)]'
          : 'text-gray-700 hover:bg-[var(--sidebar-hover)]'
      }`}
      style={{
        padding: '10px 16px',
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
        cursor: 'grab',
      }}
      {...attributes}
      {...listeners}
      onClick={() => {
        navigate(`/tasks/${list.id}`);
        if (onItemClick) onItemClick();
      }}
      onDragOver={(e) => {
        if (draggingTask) {
          e.preventDefault();
          setOverTargetId(`list-${list.id}`);
        }
      }}
      onDrop={(e) => {
        if (draggingTask && onTaskDrop) {
          e.preventDefault();
          e.stopPropagation();
          onTaskDrop(draggingTask.id, list.id);
          setOverTargetId(null);
        }
      }}
      onDragLeave={() => {
        if (overTargetId === `list-${list.id}`) setOverTargetId(null);
      }}
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
}

interface SortableGroupHeaderProps {
  group: Group;
  isExpanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
  childCount: number;
  isDropTarget?: boolean;
  draggingTask: { id: string } | null;
  onTaskDrop?: (taskId: string, listId: string) => void;
  overTargetId: string | null;
  setOverTargetId: (id: string | null) => void;
}

function SortableGroupHeader({
  group,
  isExpanded,
  onToggle,
  onDelete,
  childCount,
  isDropTarget,
  draggingTask,
  onTaskDrop,
  overTargetId,
  setOverTargetId,
}: SortableGroupHeaderProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `group-${group.id}`,
    data: { type: 'group', group },
  });

  return (
    <div
      ref={setNodeRef}
      className={`flex items-center group ${isDropTarget ? 'ring-2 ring-blue-400 ring-inset bg-blue-50' : ''}`}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
        cursor: 'grab',
      }}
      onDragOver={(e) => {
        if (draggingTask) {
          e.preventDefault();
          setOverTargetId(`group-${group.id}`);
        }
      }}
      onDrop={(e) => {
        if (draggingTask && onTaskDrop) {
          e.preventDefault();
          e.stopPropagation();
          onTaskDrop(draggingTask.id, group.id);
          setOverTargetId(null);
        }
      }}
      onDragLeave={() => {
        if (overTargetId === `group-${group.id}`) setOverTargetId(null);
      }}
    >
      <div
        onClick={onToggle}
        className="px-4 py-2 flex items-center gap-2 cursor-pointer transition-colors w-full hover:bg-[var(--sidebar-hover)]"
        {...attributes}
        {...listeners}
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
        <span className="flex-1 text-sm font-medium text-gray-700 truncate">{group.name}</span>
        <span className="text-xs text-gray-400">{childCount}</span>
        <div
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.stopPropagation();
              onDelete();
            }
          }}
          className="opacity-0 group-hover:opacity-100 p-1 hover:bg-gray-200 rounded transition-opacity cursor-pointer"
        >
          <Trash2 size={12} className="text-gray-400 hover:text-red-500" />
        </div>
      </div>
    </div>
  );
}

export interface SortableSidebarProps {
  onItemClick?: () => void;
  draggingTask: { id: string } | null;
  onTaskDrop?: (taskId: string, listId: string) => void;
}

export function SortableSidebar({ onItemClick, draggingTask, onTaskDrop }: SortableSidebarProps) {
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
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const { data: lists = [] } = useList();
  const { data: allTags = [] } = useTag();
  const { data: allGroups = [] } = useGroup();
  const createListMutation = useCreateList();
  const createTagMutation = useCreateTag();
  const createGroupMutation = useCreateGroup();
  const deleteGroupMutation = useDeleteGroup();
  const updateListMutation = useUpdateList();
  const updateGroupMutation = useUpdateGroup();
  const tagsEnabled = useTagsEnabled();

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

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  };

  const handleDragOver = (event: DragOverEvent) => {
    setOverId(event.over ? String(event.over.id) : null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    setOverId(null);

    if (!over || active.id === over.id) return;

    const activeData = active.data.current as
      | { type: string; list?: List; group?: Group }
      | undefined;
    const overData = over.data.current as { type: string; list?: List; group?: Group } | undefined;

    if (!activeData) return;

    if (activeData.type === 'list' && activeData.list) {
      const overIdStr = String(over.id);
      let targetGroupId: string | null = null;
      let targetSortOrder = 0;

      if (overIdStr.startsWith('group-')) {
        targetGroupId = overIdStr.replace('group-', '');
      } else if (overIdStr.startsWith('list-')) {
        const overListId = overIdStr.replace('list-', '');
        const overList = lists.find((l) => l.id === overListId);
        if (overList) {
          targetGroupId = overList.groupId;
          targetSortOrder = overList.sortOrder;
        }
      }

      updateListMutation.mutate({
        id: activeData.list.id,
        input: { groupId: targetGroupId, sortOrder: targetSortOrder },
      });
    } else if (activeData.type === 'group' && activeData.group) {
      const overIdStr = String(over.id);
      if (overIdStr.startsWith('group-') && overData?.group) {
        const overGroup = overData.group;
        updateGroupMutation.mutate({
          id: activeData.group.id,
          input: { sortOrder: overGroup.sortOrder },
        });
      }
    }
  };

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

  const ungroupedLists = lists.filter((list: List) => !list.groupId);

  const groupedListsMap = new Map<string, List[]>();
  lists.forEach((list: List) => {
    if (list.groupId) {
      const existing = groupedListsMap.get(list.groupId) || [];
      groupedListsMap.set(list.groupId, [...existing, list]);
    }
  });

  const allSortableItems = [
    ...ungroupedLists.map((l) => `list-${l.id}`),
    ...allGroups.map((g) => `group-${g.id}`),
  ];

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="w-[280px] h-full bg-[var(--sidebar-bg)] flex flex-col border-r border-gray-200 pt-2">
        <div className="flex-1 overflow-y-auto py-2">
          {/* Smart Lists */}
          <div className="space-y-0">
            {smartLists.map((item) => {
              const isDropTarget = draggingTask !== null && overId === `smart-${item.id}`;
              return (
                <div
                  key={item.id}
                  onClick={() => {
                    navigate(`/tasks/${item.id}`);
                    if (onItemClick) onItemClick();
                  }}
                  onDragOver={(e) => {
                    if (draggingTask) {
                      e.preventDefault();
                      setOverId(`smart-${item.id}`);
                    }
                  }}
                  onDrop={(e) => {
                    if (draggingTask && onTaskDrop) {
                      e.preventDefault();
                      onTaskDrop(draggingTask.id, item.id);
                    }
                  }}
                  onDragLeave={() => {
                    if (overId === `smart-${item.id}`) setOverId(null);
                  }}
                  className={`px-4 py-2.5 flex items-center gap-3 cursor-pointer transition-colors relative ${
                    isDropTarget ? 'ring-2 ring-blue-400 ring-inset bg-blue-50' : ''
                  } ${
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
              );
            })}
          </div>

          <div className="my-3 border-t border-gray-200 mx-4" />

          {/* Custom Lists & Groups */}
          <SortableContext items={allSortableItems} strategy={verticalListSortingStrategy}>
            <div className="space-y-0">
              {ungroupedLists.map((list: List) => {
                const isDropTarget = draggingTask !== null && overId === `list-${list.id}`;
                return (
                  <SortableListItem
                    key={list.id}
                    list={list}
                    activeListId={activeListId}
                    onItemClick={onItemClick}
                    isDropTarget={isDropTarget}
                    draggingTask={draggingTask}
                    onTaskDrop={onTaskDrop}
                    overTargetId={overId}
                    setOverTargetId={setOverId}
                  />
                );
              })}

              {/* Groups with their lists */}
              {allGroups.map((group: Group) => {
                const groupLists = groupedListsMap.get(group.id) || [];
                const isExpanded = expandedGroups.has(group.id);
                const isDropTarget = draggingTask !== null && overId === `group-${group.id}`;

                return (
                  <div key={group.id}>
                    <SortableGroupHeader
                      group={group}
                      isExpanded={isExpanded}
                      onToggle={() => toggleGroup(group.id)}
                      onDelete={() => {
                        if (confirm(`删除分组「${group.name}」？清单不会被删除。`)) {
                          deleteGroupMutation.mutate(group.id);
                        }
                      }}
                      childCount={groupLists.length}
                      isDropTarget={isDropTarget}
                      draggingTask={draggingTask}
                      onTaskDrop={onTaskDrop}
                      overTargetId={overId}
                      setOverTargetId={setOverId}
                    />

                    <AnimatePresence>
                      {isExpanded && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.2 }}
                          className="overflow-hidden"
                        >
                          <SortableContext
                            items={groupLists.map((l) => `list-${l.id}`)}
                            strategy={verticalListSortingStrategy}
                          >
                            {groupLists.map((list: List) => {
                              const isDropTarget =
                                draggingTask !== null && overId === `list-${list.id}`;
                              return (
                                <SortableListItem
                                  key={list.id}
                                  list={list}
                                  activeListId={activeListId}
                                  onItemClick={onItemClick}
                                  indent
                                  isDropTarget={isDropTarget}
                                  draggingTask={draggingTask}
                                  onTaskDrop={onTaskDrop}
                                  overTargetId={overId}
                                  setOverTargetId={setOverId}
                                />
                              );
                            })}
                          </SortableContext>
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
          </SortableContext>
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

      <DragOverlay>
        {activeId &&
          (() => {
            if (activeId.startsWith('list-')) {
              const list = lists.find((l) => l.id === activeId.replace('list-', ''));
              if (list) {
                return (
                  <div className="bg-white shadow-lg rounded border border-blue-200 px-4 py-2 text-sm font-medium opacity-90">
                    {list.title}
                  </div>
                );
              }
            }
            if (activeId.startsWith('group-')) {
              const group = allGroups.find((g) => g.id === activeId.replace('group-', ''));
              if (group) {
                return (
                  <div className="bg-white shadow-lg rounded border border-blue-200 px-4 py-2 text-sm font-medium opacity-90 flex items-center gap-2">
                    <span
                      className="w-2.5 h-2.5 rounded-full"
                      style={{ backgroundColor: group.color }}
                    />
                    {group.name}
                  </div>
                );
              }
            }
            return null;
          })()}
      </DragOverlay>
    </DndContext>
  );
}
