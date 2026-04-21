import { Input, Text, View } from '@tarojs/components';
import { useCallback, useState } from 'react';
import Taro from '@tarojs/taro';
import { type TodoItem, createTask } from '../../../types';
import './index.scss';

type FilterType = 'all' | 'today' | 'important';

const STORAGE_KEY = 'unitodo_tasks';

function loadTasks(): TodoItem[] {
  try {
    const raw = Taro.getStorageSync(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveTasks(tasks: TodoItem[]) {
  Taro.setStorageSync(STORAGE_KEY, JSON.stringify(tasks));
}

export default function Index() {
  const [tasks, setTasks] = useState<TodoItem[]>(() => loadTasks());
  const [newTask, setNewTask] = useState('');
  const [filter, setFilter] = useState<FilterType>('all');

  const persistTasks = useCallback((newTasks: TodoItem[]) => {
    setTasks(newTasks);
    saveTasks(newTasks);
  }, []);

  const addTask = () => {
    if (!newTask.trim()) return;
    persistTasks([createTask(newTask, filter === 'today'), ...tasks]);
    setNewTask('');
  };

  const toggleComplete = (id: string) => {
    persistTasks(
      tasks.map((t) =>
        t.id === id
          ? { ...t, isCompleted: !t.isCompleted, updatedAt: new Date().toISOString() }
          : t,
      ),
    );
  };

  const toggleImportant = (id: string) => {
    persistTasks(
      tasks.map((t) =>
        t.id === id
          ? { ...t, isImportant: !t.isImportant, updatedAt: new Date().toISOString() }
          : t,
      ),
    );
  };

  const deleteTask = (id: string) => {
    persistTasks(tasks.filter((t) => t.id !== id));
  };

  const filtered = tasks.filter((t) => {
    if (filter === 'today') return t.addToMyDay;
    if (filter === 'important') return t.isImportant;
    return true;
  });

  const activeTasks = filtered.filter((t) => !t.isCompleted);
  const completedTasks = filtered.filter((t) => t.isCompleted);

  const tabs: { key: FilterType; label: string }[] = [
    { key: 'all', label: '全部' },
    { key: 'today', label: '今天' },
    { key: 'important', label: '重要' },
  ];

  return (
    <View className="miniprogram-container">
      <View className="header">
        <Text className="app-title">UniTodo</Text>
      </View>

      <View className="tabs">
        {tabs.map((tab) => (
          <View
            key={tab.key}
            className={`tab ${filter === tab.key ? 'tab-active' : ''}`}
            onClick={() => setFilter(tab.key)}
          >
            <Text className={`tab-text ${filter === tab.key ? 'tab-text-active' : ''}`}>
              {tab.label}
            </Text>
          </View>
        ))}
      </View>

      <View className="add-task">
        <View className="add-btn" onClick={addTask}>
          <Text className="add-icon">+</Text>
        </View>
        <Input
          value={newTask}
          onInput={(e) => setNewTask(e.detail.value)}
          placeholder="添加任务..."
          className="task-input"
          confirmType="done"
          onConfirm={addTask}
        />
      </View>

      <View className="task-list">
        {activeTasks.length === 0 ? (
          <View className="empty">
            <Text className="empty-text">暂无任务</Text>
          </View>
        ) : (
          activeTasks.map((task) => (
            <View key={task.id} className="task-item">
              <View className="task-left" onClick={() => toggleComplete(task.id)}>
                <View className={`checkbox ${task.isCompleted ? 'checkbox-done' : ''}`}>
                  {task.isCompleted && <Text className="check-icon">✓</Text>}
                </View>
                <Text className={`task-title ${task.isCompleted ? 'task-done' : ''}`}>
                  {task.title}
                </Text>
              </View>
              <View className="task-actions">
                <View onClick={() => toggleImportant(task.id)} className="action-btn">
                  <Text className={`star-icon ${task.isImportant ? 'star-active' : ''}`}>★</Text>
                </View>
                <View onClick={() => deleteTask(task.id)} className="action-btn">
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
            <View key={task.id} className="task-item">
              <View className="task-left" onClick={() => toggleComplete(task.id)}>
                <View className="checkbox checkbox-done">
                  <Text className="check-icon">✓</Text>
                </View>
                <Text className="task-title task-done">{task.title}</Text>
              </View>
              <View onClick={() => deleteTask(task.id)} className="action-btn">
                <Text className="delete-icon">×</Text>
              </View>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}
