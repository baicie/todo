import { Input, Text, View } from '@tarojs/components';
import { useCallback, useState } from 'react';
import Taro from '@tarojs/taro';
import {
  useAuth,
  useCreateTask,
  useDeleteTask,
  useTask,
  useToggleComplete,
  useToggleImportant,
  useToggleMyDay,
} from '@baicie/orbit-hooks';
import type { Task } from '@baicie/orbit';
import './index.scss';

type FilterType = 'my-day' | 'important' | 'planned' | 'tasks';

export default function Index() {
  const [activeFilter, setActiveFilter] = useState<FilterType>('my-day');
  const [newTask, setNewTask] = useState('');
  const { isLoading: authLoading } = useAuth();

  const getFilter = useCallback(() => {
    switch (activeFilter) {
      case 'my-day':
        return { addToMyDay: true };
      case 'important':
        return { isImportant: true };
      case 'tasks':
        return {};
      default:
        return {};
    }
  }, [activeFilter]);

  const { data: tasks = [], isLoading: tasksLoading } = useTask(getFilter());
  const createTaskMutation = useCreateTask();
  const deleteTaskMutation = useDeleteTask();
  const toggleCompleteMutation = useToggleComplete();
  const toggleImportantMutation = useToggleImportant();
  const toggleMyDayMutation = useToggleMyDay();

  const handleAddTask = () => {
    if (!newTask.trim()) return;
    createTaskMutation.mutate(
      {
        title: newTask.trim(),
        addToMyDay: activeFilter === 'my-day',
      },
      {
        onSuccess: () => setNewTask(''),
      },
    );
  };

  const handleToggleComplete = (task: Task) => {
    toggleCompleteMutation(task);
  };

  const handleToggleImportant = (task: Task) => {
    toggleImportantMutation(task);
  };

  const handleToggleMyDay = (task: Task) => {
    toggleMyDayMutation(task);
  };

  const handleDeleteTask = (taskId: string) => {
    Taro.showModal({
      title: '删除任务',
      content: '确定要删除这个任务吗？',
      success: (res) => {
        if (res.confirm) {
          deleteTaskMutation.mutate(taskId);
        }
      },
    });
  };

  const activeTasks = tasks.filter((t) => !t.isCompleted);
  const completedTasks = tasks.filter((t) => t.isCompleted);

  const tabs: { key: FilterType; label: string }[] = [
    { key: 'my-day', label: '我的一天' },
    { key: 'important', label: '重要' },
    { key: 'tasks', label: '全部' },
  ];

  const getFilterLabel = () => {
    switch (activeFilter) {
      case 'my-day':
        return '我的一天';
      case 'important':
        return '重要';
      case 'planned':
        return '已计划';
      case 'tasks':
        return '全部任务';
      default:
        return '任务';
    }
  };

  return (
    <View className="miniprogram-container">
      <View className="header">
        <Text className="app-title">Orbit</Text>
        <Text className="filter-label">{getFilterLabel()}</Text>
      </View>

      {authLoading || tasksLoading ? (
        <View className="loading">
          <Text className="loading-text">加载中...</Text>
        </View>
      ) : (
        <>
          <View className="tabs">
            {tabs.map((tab) => (
              <View
                key={tab.key}
                className={`tab ${activeFilter === tab.key ? 'tab-active' : ''}`}
                onClick={() => setActiveFilter(tab.key)}
              >
                <Text className={`tab-text ${activeFilter === tab.key ? 'tab-text-active' : ''}`}>
                  {tab.label}
                </Text>
              </View>
            ))}
          </View>

          <View className="add-task">
            <View className="add-btn" onClick={handleAddTask}>
              <Text className="add-icon">+</Text>
            </View>
            <Input
              value={newTask}
              onInput={(e) => setNewTask(e.detail.value)}
              placeholder="添加任务..."
              className="task-input"
              confirmType="done"
              onConfirm={handleAddTask}
            />
          </View>

          <View className="task-list">
            {activeTasks.length === 0 ? (
              <View className="empty">
                <Text className="empty-icon">📋</Text>
                <Text className="empty-text">暂无任务</Text>
                <Text className="empty-subtext">点击上方「+」添加任务</Text>
              </View>
            ) : (
              activeTasks.map((task) => (
                <View key={task.id} className="task-item">
                  <View className="task-left" onClick={() => handleToggleComplete(task)}>
                    <View className={`checkbox ${task.isCompleted ? 'checkbox-done' : ''}`}>
                      {task.isCompleted && <Text className="check-icon">✓</Text>}
                    </View>
                    <View className="task-content">
                      <Text
                        className={`task-title ${task.isCompleted ? 'task-done' : ''}`}
                        numberOfLines={2}
                      >
                        {task.title}
                      </Text>
                      {task.steps.length > 0 && (
                        <Text className="task-steps">
                          {task.steps.filter((s) => s.isCompleted).length}/{task.steps.length} 步骤
                        </Text>
                      )}
                    </View>
                  </View>
                  <View className="task-actions">
                    <View onClick={() => handleToggleMyDay(task)} className="action-btn">
                      <Text className={`myday-icon ${task.addToMyDay ? 'myday-active' : ''}`}>
                        ☀
                      </Text>
                    </View>
                    <View onClick={() => handleToggleImportant(task)} className="action-btn">
                      <Text className={`star-icon ${task.isImportant ? 'star-active' : ''}`}>
                        ★
                      </Text>
                    </View>
                    <View onClick={() => handleDeleteTask(task.id)} className="action-btn">
                      <Text className="delete-icon">×</Text>
                    </View>
                  </View>
                </View>
              ))
            )}
          </View>

          {completedTasks.length > 0 && (
            <View className="completed-section">
              <Text className="completed-title">已完成 ({completedTasks.length})</Text>
              {completedTasks.map((task) => (
                <View key={task.id} className="task-item task-item-done">
                  <View className="task-left" onClick={() => handleToggleComplete(task)}>
                    <View className="checkbox checkbox-done">
                      <Text className="check-icon">✓</Text>
                    </View>
                    <Text className="task-title task-done" numberOfLines={2}>
                      {task.title}
                    </Text>
                  </View>
                  <View onClick={() => handleDeleteTask(task.id)} className="action-btn">
                    <Text className="delete-icon">×</Text>
                  </View>
                </View>
              ))}
            </View>
          )}
        </>
      )}
    </View>
  );
}
