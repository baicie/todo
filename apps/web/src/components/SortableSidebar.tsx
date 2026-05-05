import {
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  rectIntersection,
  useDroppable,
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
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Edit3,
  Folder,
  FolderPlus,
  Home,
  List as ListIcon,
  Plus,
  Star,
  Sun,
  Trash2,
} from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import {
  useCreateGroup,
  useCreateList,
  useCreateTag,
  useDeleteGroup,
  useDeleteList,
  useGroup,
  useList,
  useTag,
  useUpdateGroup,
  useUpdateList,
} from '@baicie/orbit-hooks';
import { useTagsEnabled } from '../hooks/useTagsEnabled';
import { Button, Input } from '@baicie/orbit-ui';
import { useSidebar } from '../contexts/SidebarContext';

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
  onContextMenu?: (e: React.MouseEvent) => void;
  isEditing?: boolean;
  editingName?: string;
  onEditingNameChange?: (name: string) => void;
  onRename?: () => void;
  onCancelEdit?: () => void;
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
  onContextMenu,
  isEditing,
  editingName,
  onEditingNameChange,
  onRename,
  onCancelEdit,
  indent = false,
}: SortableListItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `list-${list.id}`,
    data: { type: 'list', list },
  });

  const navigate = useNavigate();

  if (isEditing) {
    return (
      <div
        ref={setNodeRef}
        className={`flex items-center gap-3 ${indent ? 'pl-10' : ''}`}
        style={{ padding: '10px 16px' }}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu?.(e);
        }}
      >
        <ListIcon size={20} strokeWidth={1.5} className="text-gray-400 flex-shrink-0" />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onRename?.();
          }}
          className="flex-1"
        >
          <input
            autoFocus
            type="text"
            value={editingName}
            onChange={(e) => onEditingNameChange?.(e.target.value)}
            onBlur={() => onRename?.()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onCancelEdit?.();
            }}
            className="w-full bg-transparent border-none outline-none text-sm text-gray-900 focus-visible:outline-none px-0"
          />
        </form>
      </div>
    );
  }

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
      onContextMenu={onContextMenu}
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
  isDropTarget?: boolean;
  draggingTask: { id: string } | null;
  onTaskDrop?: (taskId: string, listId: string) => void;
  overTargetId: string | null;
  setOverTargetId: (id: string | null) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}

function SortableGroupHeader({
  group,
  isExpanded,
  onToggle,
  isDropTarget,
  draggingTask,
  onTaskDrop,
  overTargetId,
  setOverTargetId,
  onContextMenu,
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
          if (!isExpanded) onToggle();
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
      onContextMenu={onContextMenu}
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
        <Folder size={18} className="text-gray-500" strokeWidth={1.5} />
        <span className="flex-1 text-sm text-gray-700 truncate">{group.name}</span>
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
  const { isCollapsed, isMobileOpen, toggleCollapse, closeMobile } = useSidebar();
  const [isCreating, setIsCreating] = useState(false);
  const [newListTitle, setNewListTitle] = useState('');
  const [isCreatingTag, setIsCreatingTag] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [isTagsExpanded, setIsTagsExpanded] = useState(true);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState('');
  const [editingListId, setEditingListId] = useState<string | null>(null);
  const [editingListName, setEditingListName] = useState('');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [deleteConfirmGroupId, setDeleteConfirmGroupId] = useState<string | null>(null);
  const [emptyGroupHandled, setEmptyGroupHandled] = useState(false);
  const originalGroupIdRef = useRef<string | null>(null);

  const { data: lists = [] } = useList();
  const { data: allTags = [] } = useTag();
  const { data: allGroups = [] } = useGroup();
  const createListMutation = useCreateList();
  const createTagMutation = useCreateTag();
  const createGroupMutation = useCreateGroup();
  const deleteGroupMutation = useDeleteGroup();
  const deleteListMutation = useDeleteList();
  const updateListMutation = useUpdateList();
  const updateGroupMutation = useUpdateGroup();
  const tagsEnabled = useTagsEnabled();

  function EmptyGroupDropZone({
    groupId,
    isOver,
    draggingTask,
    draggingListId,
    onDragEnter,
    onDragLeave,
    onListDropped,
  }: {
    groupId: string;
    isOver: boolean;
    draggingTask: { id: string } | null;
    draggingListId?: string;
    onDragEnter: () => void;
    onDragLeave: () => void;
    onListDropped: (listId: string, groupId: string) => void;
  }) {
    const { setNodeRef } = useDroppable({ id: `empty-group-${groupId}` });

    return (
      <div
        ref={setNodeRef}
        className={`pr-4 pl-6 py-3 relative ${isOver ? 'bg-blue-50' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (draggingTask || draggingListId) onDragEnter();
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (draggingTask) {
            onTaskDrop?.(draggingTask.id, groupId);
          } else if (draggingListId) {
            onListDropped(draggingListId, groupId);
          }
          onDragLeave();
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            onDragLeave();
          }
        }}
      >
        <div
          className={`absolute top-0 w-[2px] rounded transition-colors ${
            isOver ? 'bg-blue-400 h-full' : 'bg-gray-200 h-full'
          }`}
          style={{ left: '18px' }}
        />
        <span className="relative z-10 text-sm text-gray-400 select-none">拖到此处来添加列表</span>
      </div>
    );
  }

  const [contextMenu, setContextMenu] = useState<{
    type: 'list' | 'group';
    id: string;
    x: number;
    y: number;
  } | null>(null);

  const customCollisionDetection: CollisionDetection = (args) => {
    const draggable = args.active.data.current as { type?: string } | undefined;

    if (draggable?.type === 'list' && args.pointerCoordinates) {
      const px = args.pointerCoordinates.x;
      const py = args.pointerCoordinates.y;
      const pointerInAnyGroup = args.droppableContainers.some((container) => {
        const rect = args.droppableRects.get(container.id);
        if (!rect) return false;
        if (!String(container.id).startsWith('group-')) return false;
        return px >= rect.left && px <= rect.right && py >= rect.top && py <= rect.bottom;
      });

      if (!pointerInAnyGroup) {
        const listCollisions = closestCenter(args);
        return listCollisions;
      }

      const groupCollisions = rectIntersection(args);
      const overlappingGroups = groupCollisions.filter((c) => String(c.id).startsWith('group-'));
      if (overlappingGroups.length > 0) {
        return overlappingGroups;
      }
    }

    return closestCenter(args);
  };

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        delay: 150,
        tolerance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const contextMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const handleListDropped = (listId: string, groupId: string) => {
    setEmptyGroupHandled(true);
    updateListMutation.mutate({
      id: listId,
      input: { groupId, sortOrder: Date.now() },
    });
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(String(event.active.id));
    setContextMenu(null);
    const activeData = event.active.data.current as
      | { type?: string; list?: List; group?: Group }
      | undefined;
    originalGroupIdRef.current = activeData?.list?.groupId ?? null;
  };

  const handleDragOver = (event: DragOverEvent) => {
    const overId = event.over ? String(event.over.id) : null;
    setOverId(overId);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    setOverId(null);
    const wasEmptyGroupHandled = emptyGroupHandled;
    setEmptyGroupHandled(false);
    const originalGroupId = originalGroupIdRef.current;
    originalGroupIdRef.current = null;

    if (!over || active.id === over.id) return;

    if (wasEmptyGroupHandled) return;

    const activeData = active.data.current as
      | { type: string; list?: List; group?: Group }
      | undefined;
    const overIdStr = String(over.id);

    if (activeData?.type === 'list' && activeData.list) {
      const listInOriginalGroup = originalGroupId !== null;
      const droppedOnGroup = overIdStr.startsWith('group-');
      const droppedOnEmptyGroup = overIdStr.startsWith('empty-group-');

      if (listInOriginalGroup && !droppedOnGroup && !droppedOnEmptyGroup) {
        updateListMutation.mutate({
          id: activeData.list.id,
          input: { groupId: null, sortOrder: Date.now() },
        });
        return;
      }

      let targetGroupId: string | null = null;
      let targetSortOrder: number;

      if (droppedOnGroup) {
        targetGroupId = overIdStr.replace('group-', '');
        targetSortOrder = Date.now();
      } else if (droppedOnEmptyGroup) {
        targetGroupId = overIdStr.replace('empty-group-', '');
        targetSortOrder = Date.now();
      } else if (overIdStr.startsWith('list-')) {
        const overListId = overIdStr.replace('list-', '');
        const overList = lists.find((l) => l.id === overListId);
        if (overList) {
          targetGroupId = overList.groupId;
          targetSortOrder = overList.sortOrder;
        } else {
          targetSortOrder = Date.now();
        }
      } else {
        targetSortOrder = Date.now();
      }

      updateListMutation.mutate({
        id: activeData.list.id,
        input: { groupId: targetGroupId, sortOrder: targetSortOrder },
      });
    } else if (activeData?.type === 'group' && activeData.group) {
      if (overIdStr.startsWith('group-') && over.data.current) {
        const overData = over.data.current as { type: string; group?: Group };
        if (overData.type === 'group' && overData.group) {
          updateGroupMutation.mutate({
            id: activeData.group.id,
            input: { sortOrder: overData.group.sortOrder },
          });
        }
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

  const handleCreateGroup = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const tempId = `pending-group-${Date.now()}`;
    setEditingGroupId(tempId);
    setEditingGroupName('');
  };

  const handleConfirmGroup = () => {
    const name = editingGroupName.trim();
    if (name) {
      createGroupMutation.mutate(
        { name, color: '#6366f1' },
        {
          onSuccess: (newGroup) => {
            setExpandedGroups((prev) => new Set([...prev, newGroup.id]));
          },
        },
      );
    }
    setEditingGroupId(null);
    setEditingGroupName('');
  };

  const handleRenameGroup = (groupId: string) => {
    if (editingGroupName.trim()) {
      updateGroupMutation.mutate({
        id: groupId,
        input: { name: editingGroupName.trim() },
      });
    } else {
      deleteGroupMutation.mutate(groupId);
    }
    setEditingGroupId(null);
    setEditingGroupName('');
  };

  const handleRenameList = (listId: string) => {
    if (editingListName.trim()) {
      updateListMutation.mutate({
        id: listId,
        input: { title: editingListName.trim() },
      });
    }
    setEditingListId(null);
    setEditingListName('');
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

  // Collapsed sidebar content (icons only)
  const renderCollapsedContent = () => (
    <div className="w-14 h-full bg-[var(--sidebar-bg)] flex flex-col border-r border-gray-200 py-2">
      <div className="flex-1 overflow-y-auto">
        {/* Smart Lists (collapsed) */}
        {smartLists.map((item) => (
          <div
            key={item.id}
            onClick={() => {
              navigate(`/tasks/${item.id}`);
              if (onItemClick) onItemClick();
            }}
            className={`w-14 h-12 flex items-center justify-center cursor-pointer transition-colors ${
              activeListId === item.id
                ? 'text-[var(--theme-primary)]'
                : 'text-gray-700 hover:bg-[var(--sidebar-hover)]'
            }`}
            title={item.label}
          >
            <item.icon size={20} strokeWidth={1.5} />
          </div>
        ))}

        <div className="my-3 border-t border-gray-200 mx-3" />

        {/* Custom Lists (collapsed) */}
        {ungroupedLists.map((list: List) => (
          <div
            key={list.id}
            onClick={() => {
              navigate(`/tasks/${list.id}`);
              if (onItemClick) onItemClick();
            }}
            className={`w-14 h-12 flex items-center justify-center cursor-pointer transition-colors ${
              activeListId === list.id
                ? 'text-[var(--theme-primary)]'
                : 'text-gray-700 hover:bg-[var(--sidebar-hover)]'
            }`}
            title={list.title}
          >
            <ListIcon size={20} strokeWidth={1.5} />
          </div>
        ))}

        {/* Groups (collapsed - first item only) */}
        {allGroups.map((group: Group) => {
          const groupLists = groupedListsMap.get(group.id) || [];
          const firstList = groupLists[0];
          return (
            <div
              key={group.id}
              onClick={() => {
                if (firstList) {
                  navigate(`/tasks/${firstList.id}`);
                } else {
                  navigate(`/tasks/my-day`);
                }
                if (onItemClick) onItemClick();
              }}
              className={`w-14 h-12 flex items-center justify-center cursor-pointer transition-colors ${
                groupLists.some((l) => activeListId === l.id)
                  ? 'text-[var(--theme-primary)]'
                  : 'text-gray-700 hover:bg-[var(--sidebar-hover)]'
              }`}
              title={group.name}
            >
              <Folder size={18} strokeWidth={1.5} />
            </div>
          );
        })}
      </div>

      {/* Expand button */}
      <div className="p-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleCollapse}
          className="w-10 h-10 text-gray-500 hover:bg-gray-100"
          title="展开侧边栏"
        >
          <ChevronRight size={18} />
        </Button>
      </div>
    </div>
  );

  // Full sidebar content
  const renderFullContent = () => (
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
              const isEditing = editingListId === list.id;
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
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setContextMenu({ type: 'list', id: list.id, x: e.clientX, y: e.clientY });
                  }}
                  isEditing={isEditing}
                  editingName={editingListName}
                  onEditingNameChange={setEditingListName}
                  onRename={() => handleRenameList(list.id)}
                  onCancelEdit={() => {
                    setEditingListId(null);
                    setEditingListName('');
                  }}
                />
              );
            })}

            {/* Groups with their lists */}
            {allGroups.map((group: Group) => {
              const groupLists = groupedListsMap.get(group.id) || [];
              const isExpanded = expandedGroups.has(group.id);
              const isDropTarget = draggingTask !== null && overId === `group-${group.id}`;
              const isEditing = editingGroupId === group.id;

              return (
                <div key={group.id}>
                  {isEditing ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        handleRenameGroup(group.id);
                      }}
                      className="px-4 py-2 flex items-center gap-2"
                    >
                      <Folder size={18} className="text-gray-500" strokeWidth={1.5} />
                      <Input
                        type="text"
                        value={editingGroupName}
                        onChange={(e) => setEditingGroupName(e.target.value)}
                        placeholder="输入分组名称"
                        autoFocus
                        className="flex-1 h-8 focus-visible:outline-none"
                        onBlur={() => handleRenameGroup(group.id)}
                      />
                    </form>
                  ) : (
                    <SortableGroupHeader
                      group={group}
                      isExpanded={isExpanded}
                      onToggle={() => toggleGroup(group.id)}
                      isDropTarget={isDropTarget}
                      draggingTask={draggingTask}
                      onTaskDrop={onTaskDrop}
                      overTargetId={overId}
                      setOverTargetId={setOverId}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setContextMenu({ type: 'group', id: group.id, x: e.clientX, y: e.clientY });
                      }}
                    />
                  )}

                  <AnimatePresence>
                    {isExpanded && !isEditing && (
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
                            const isEditing = editingListId === list.id;
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
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  setContextMenu({
                                    type: 'list',
                                    id: list.id,
                                    x: e.clientX,
                                    y: e.clientY,
                                  });
                                }}
                                isEditing={isEditing}
                                editingName={editingListName}
                                onEditingNameChange={setEditingListName}
                                onRename={() => handleRenameList(list.id)}
                                onCancelEdit={() => {
                                  setEditingListId(null);
                                  setEditingListName('');
                                }}
                              />
                            );
                          })}
                          {/* Empty group drop zone */}
                          {groupLists.length === 0 && (
                            <EmptyGroupDropZone
                              groupId={group.id}
                              isOver={
                                (draggingTask !== null ||
                                  (activeId?.startsWith('list-') ?? false)) &&
                                overId === `empty-group-${group.id}`
                              }
                              draggingTask={draggingTask}
                              draggingListId={
                                activeId?.startsWith('list-')
                                  ? activeId.replace('list-', '')
                                  : undefined
                              }
                              onDragEnter={() => setOverId(`empty-group-${group.id}`)}
                              onDragLeave={() => {
                                if (overId === `empty-group-${group.id}`) setOverId(null);
                              }}
                              onListDropped={handleListDropped}
                            />
                          )}
                        </SortableContext>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}

            {/* Pending local group (not yet created) */}
            {editingGroupId && editingGroupId.startsWith('pending-group') && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleConfirmGroup();
                }}
                className="px-4 py-2 flex items-center gap-2"
              >
                <Folder size={18} className="text-gray-500" strokeWidth={1.5} />
                <Input
                  type="text"
                  value={editingGroupName}
                  onChange={(e) => setEditingGroupName(e.target.value)}
                  placeholder="输入分组名称"
                  autoFocus
                  className="flex-1 h-8 focus-visible:outline-none"
                  onBlur={() => handleConfirmGroup()}
                />
              </form>
            )}

            {/* Create Group Button - moved to bottom area */}
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

      {/* Bottom: New List + New Group (4:1) */}
      <div className="p-3 border-t border-gray-200">
        <div className="flex items-center gap-2">
          {/* New List */}
          <div className="flex-4">
            {isCreating ? (
              <div className="flex items-center gap-2">
                <Plus size={18} className="text-[var(--theme-primary)] flex-shrink-0" />
                <form onSubmit={(e) => handleCreateList(e)} className="flex-1">
                  <Input
                    type="text"
                    value={newListTitle}
                    onChange={(e) => setNewListTitle(e.target.value)}
                    placeholder={t('sidebar.newList')}
                    autoFocus
                    className="w-full border-none shadow-none bg-transparent focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 px-0"
                    onBlur={() => {
                      if (!newListTitle.trim()) setIsCreating(false);
                    }}
                  />
                </form>
              </div>
            ) : (
              <Button
                onClick={() => setIsCreating(true)}
                variant="ghost"
                className="w-full justify-start text-[var(--theme-primary)] hover:bg-[var(--sidebar-hover)]"
              >
                <Plus size={18} />
                <span className="text-sm font-medium">{t('sidebar.createList')}</span>
              </Button>
            )}
          </div>
          {/* New Group */}
          <div className="flex-1">
            <Button
              onClick={() => handleCreateGroup()}
              variant="ghost"
              className="w-full justify-center text-gray-500 hover:text-gray-700"
              title="新建分组"
            >
              <FolderPlus size={18} />
            </Button>
          </div>
        </div>
      </div>

      {/* Collapse button */}
      <div className="p-2 border-t border-gray-200">
        <Button
          variant="ghost"
          size="sm"
          onClick={toggleCollapse}
          className="w-full justify-start text-gray-500 hover:bg-gray-100"
        >
          <ChevronLeft size={16} />
          <span className="text-sm">收起</span>
        </Button>
      </div>

      {/* Context Menu */}
      {contextMenu &&
        (() => {
          const isListMenu = contextMenu.type === 'list';
          const isGroupMenu = contextMenu.type === 'group';

          const list = isListMenu ? lists.find((l) => l.id === contextMenu.id) : null;
          const group = isGroupMenu ? allGroups.find((g) => g.id === contextMenu.id) : null;

          const mergedItems: Array<{
            id: string;
            sortOrder: number;
            type: 'list' | 'group';
            name: string;
          }> = [
            ...ungroupedLists.map((l) => ({
              id: l.id,
              sortOrder: l.sortOrder,
              type: 'list' as const,
              name: l.title,
            })),
            ...allGroups.map((g) => ({
              id: g.id,
              sortOrder: g.sortOrder,
              type: 'group' as const,
              name: g.name,
            })),
          ].sort((a, b) => a.sortOrder - b.sortOrder);

          const currentItem = list
            ? { id: list.id, sortOrder: list.sortOrder, type: 'list' as const, name: list.title }
            : group
              ? {
                  id: group.id,
                  sortOrder: group.sortOrder,
                  type: 'group' as const,
                  name: group.name,
                }
              : null;

          const currentIndex = currentItem
            ? mergedItems.findIndex((item) => item.id === currentItem.id)
            : -1;

          const canListMoveUp = list
            ? list.groupId
              ? lists.filter((l) => l.groupId === list.groupId).findIndex((l) => l.id === list.id) >
                0
              : mergedItems.findIndex((item) => item.id === list.id) > 0
            : false;
          const canListMoveDown = list
            ? list.groupId
              ? lists.filter((l) => l.groupId === list.groupId).findIndex((l) => l.id === list.id) <
                lists.filter((l) => l.groupId === list.groupId).length - 1
              : mergedItems.findIndex((item) => item.id === list.id) < mergedItems.length - 1
            : false;
          const canGroupMoveUp = group ? currentIndex > 0 : false;
          const canGroupMoveDown = group ? currentIndex < mergedItems.length - 1 : false;

          return (
            <div
              ref={contextMenuRef}
              className="fixed z-50 min-w-[160px] overflow-hidden rounded-md border border-gray-200 bg-white shadow-lg"
              style={{ left: contextMenu.x, top: contextMenu.y }}
            >
              <div className="py-1">
                {/* Rename */}
                <div
                  className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer text-gray-700 hover:bg-gray-100"
                  onClick={() => {
                    if (isListMenu && list) {
                      setEditingListId(list.id);
                      setEditingListName(list.title);
                    } else if (isGroupMenu && group) {
                      setEditingGroupId(group.id);
                      setEditingGroupName(group.name);
                    }
                    setContextMenu(null);
                  }}
                >
                  <Edit3 size={14} />
                  <span>重命名</span>
                </div>

                <div className="my-1 h-px bg-gray-100" />

                {/* Move Up - only render if can move up */}
                {(isListMenu ? canListMoveUp : isGroupMenu ? canGroupMoveUp : false) && (
                  <div
                    className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer text-gray-700 hover:bg-gray-100"
                    onClick={() => {
                      if (currentIndex <= 0) return;
                      const prevItem = mergedItems[currentIndex - 1];
                      if (currentItem?.type === 'list') {
                        updateListMutation.mutate({
                          id: currentItem.id,
                          input: { sortOrder: prevItem.sortOrder - 1 },
                        });
                      } else if (currentItem?.type === 'group') {
                        updateGroupMutation.mutate({
                          id: currentItem.id,
                          input: { sortOrder: prevItem.sortOrder - 1 },
                        });
                      }
                      setContextMenu(null);
                    }}
                  >
                    <ChevronUp size={14} />
                    <span>上移</span>
                  </div>
                )}

                {/* Move Down - only render if can move down */}
                {(isListMenu ? canListMoveDown : isGroupMenu ? canGroupMoveDown : false) && (
                  <div
                    className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer text-gray-700 hover:bg-gray-100"
                    onClick={() => {
                      if (currentIndex < 0 || currentIndex >= mergedItems.length - 1) return;
                      const nextItem = mergedItems[currentIndex + 1];
                      if (currentItem?.type === 'list') {
                        updateListMutation.mutate({
                          id: currentItem.id,
                          input: { sortOrder: nextItem.sortOrder + 1 },
                        });
                      } else if (currentItem?.type === 'group') {
                        updateGroupMutation.mutate({
                          id: currentItem.id,
                          input: { sortOrder: nextItem.sortOrder + 1 },
                        });
                      }
                      setContextMenu(null);
                    }}
                  >
                    <ChevronDown size={14} />
                    <span>下移</span>
                  </div>
                )}

                <div className="my-1 h-px bg-gray-100" />

                {/* Delete / Cancel Group */}
                {isListMenu ? (
                  <div
                    className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer text-red-600 hover:bg-red-50"
                    onClick={() => {
                      deleteListMutation.mutate(contextMenu.id);
                      setContextMenu(null);
                    }}
                  >
                    <Trash2 size={14} />
                    <span>删除</span>
                  </div>
                ) : (
                  <div
                    className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer text-red-600 hover:bg-red-50"
                    onClick={() => {
                      setDeleteConfirmGroupId(contextMenu.id);
                      setContextMenu(null);
                    }}
                  >
                    <Trash2 size={14} />
                    <span>取消分组</span>
                  </div>
                )}
              </div>
            </div>
          );
        })()}
    </div>
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={customCollisionDetection}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      {/* Desktop: collapsible sidebar */}
      <div className="hidden md:block flex-shrink-0">
        {isCollapsed ? renderCollapsedContent() : renderFullContent()}
      </div>

      {/* Mobile: overlay sidebar */}
      <AnimatePresence>
        {isMobileOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={closeMobile}
              className="fixed inset-0 bg-black/20 z-40 md:hidden"
            />
            <motion.div
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
              className="fixed inset-y-0 left-0 z-50 md:hidden"
            >
              {renderFullContent()}
            </motion.div>
          </>
        )}
      </AnimatePresence>

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
                    <Folder size={16} className="text-gray-500" />
                    {group.name}
                  </div>
                );
              }
            }
            return null;
          })()}
      </DragOverlay>

      {/* Cancel Group Confirmation Dialog */}
      {deleteConfirmGroupId !== null && (
        <>
          <div
            className="fixed inset-0 bg-black/30 backdrop-blur-sm z-50"
            onClick={() => setDeleteConfirmGroupId(null)}
          />
          <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 bg-white rounded-xl shadow-2xl w-full max-w-sm p-5">
            <h2 className="text-lg font-semibold text-gray-900 mb-2">取消分组</h2>
            <p className="text-sm text-gray-600 mb-5">
              确定要取消分组「{allGroups.find((g) => g.id === deleteConfirmGroupId)?.name}
              」吗？分组内的清单将移至未分组。
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDeleteConfirmGroupId(null)}>
                取消
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  deleteGroupMutation.mutate(deleteConfirmGroupId);
                  setDeleteConfirmGroupId(null);
                }}
              >
                取消分组
              </Button>
            </div>
          </div>
        </>
      )}
    </DndContext>
  );
}
