import { useState } from 'react';
import {
  FlatList,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { type TodoItem, createTask } from './types';

type FilterType = 'all' | 'today' | 'important';

export default function TaskListScreen() {
  const [tasks, setTasks] = useState<TodoItem[]>([]);
  const [newTask, setNewTask] = useState('');
  const [filter, setFilter] = useState<FilterType>('all');

  const addTask = () => {
    if (!newTask.trim()) return;
    setTasks((prev) => [createTask(newTask, filter === 'today'), ...prev]);
    setNewTask('');
  };

  const toggleComplete = (id: string) => {
    setTasks((prev) =>
      prev.map((t) =>
        t.id === id
          ? { ...t, isCompleted: !t.isCompleted, updatedAt: new Date().toISOString() }
          : t,
      ),
    );
  };

  const toggleImportant = (id: string) => {
    setTasks((prev) =>
      prev.map((t) =>
        t.id === id
          ? { ...t, isImportant: !t.isImportant, updatedAt: new Date().toISOString() }
          : t,
      ),
    );
  };

  const deleteTask = (id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
  };

  const filtered = tasks.filter((t) => {
    if (filter === 'today') return t.addToMyDay;
    if (filter === 'important') return t.isImportant;
    return true;
  });

  const activeTasks = filtered.filter((t) => !t.isCompleted);
  const completedTasks = filtered.filter((t) => t.isCompleted);

  const tabs: { key: FilterType; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
    { key: 'all', label: '全部', icon: 'list' },
    { key: 'today', label: '今天', icon: 'sunny' },
    { key: 'important', label: '重要', icon: 'star' },
  ];

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.header}>
        <Text style={styles.appTitle}>Orbit</Text>
      </View>

      <View style={styles.tabs}>
        {tabs.map((tab) => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tab, filter === tab.key && styles.tabActive]}
            onPress={() => setFilter(tab.key)}
          >
            <Ionicons
              name={tab.icon}
              size={16}
              color={filter === tab.key ? '#3b82f6' : '#9ca3af'}
            />
            <Text style={[styles.tabText, filter === tab.key && styles.tabTextActive]}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.addTask}>
        <TouchableOpacity onPress={addTask} style={styles.addButton}>
          <Ionicons name="add" size={24} color="#3b82f6" />
        </TouchableOpacity>
        <TextInput
          value={newTask}
          onChangeText={setNewTask}
          placeholder="添加任务..."
          style={styles.input}
          placeholderTextColor="#9ca3af"
          onSubmitEditing={addTask}
          returnKeyType="done"
        />
      </View>

      <FlatList
        data={activeTasks}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <View style={styles.taskItem}>
            <TouchableOpacity onPress={() => toggleComplete(item.id)} style={styles.taskLeft}>
              <View style={[styles.checkbox, item.isCompleted && styles.checkboxDone]} />
              <Text style={[styles.taskTitle, item.isCompleted && styles.taskTitleDone]}>
                {item.title}
              </Text>
            </TouchableOpacity>
            <View style={styles.taskActions}>
              <TouchableOpacity onPress={() => toggleImportant(item.id)} style={styles.actionBtn}>
                <Ionicons
                  name={item.isImportant ? 'star' : 'star-outline'}
                  size={20}
                  color={item.isImportant ? '#f59e0b' : '#9ca3af'}
                />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => deleteTask(item.id)} style={styles.actionBtn}>
                <Ionicons name="trash-outline" size={18} color="#9ca3af" />
              </TouchableOpacity>
            </View>
          </View>
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="clipboard-outline" size={48} color="#e5e7eb" />
            <Text style={styles.emptyText}>暂无任务</Text>
          </View>
        }
      />

      {completedTasks.length > 0 && (
        <View style={styles.completedSection}>
          <Text style={styles.completedTitle}>已完成 ({completedTasks.length})</Text>
          {completedTasks.map((task) => (
            <View key={task.id} style={styles.taskItem}>
              <TouchableOpacity onPress={() => toggleComplete(task.id)} style={styles.taskLeft}>
                <View style={[styles.checkbox, styles.checkboxDone]}>
                  <Ionicons name="checkmark" size={14} color="#fff" />
                </View>
                <Text style={[styles.taskTitle, styles.taskTitleDone]}>{task.title}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => deleteTask(task.id)} style={styles.actionBtn}>
                <Ionicons name="trash-outline" size={18} color="#9ca3af" />
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  header: { paddingHorizontal: 16, paddingVertical: 12 },
  appTitle: { fontSize: 24, fontWeight: '700', color: '#3b82f6' },
  tabs: { flexDirection: 'row', paddingHorizontal: 12, marginBottom: 8 },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 8,
    borderRadius: 8,
  },
  tabActive: { backgroundColor: '#eff6ff' },
  tabText: { fontSize: 13, color: '#9ca3af' },
  tabTextActive: { color: '#3b82f6', fontWeight: '600' },
  addTask: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginBottom: 12,
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 2,
  },
  addButton: { marginRight: 8 },
  input: { flex: 1, fontSize: 15, color: '#111827' },
  list: { paddingHorizontal: 16 },
  taskItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    marginBottom: 8,
    shadowColor: '#000',
    shadowOpacity: 0.03,
    shadowRadius: 1,
  },
  taskLeft: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  checkbox: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: '#d1d5db' },
  checkboxDone: {
    backgroundColor: '#3b82f6',
    borderColor: '#3b82f6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  taskTitle: { flex: 1, fontSize: 15, color: '#111827' },
  taskTitleDone: { textDecorationLine: 'line-through', color: '#9ca3af' },
  taskActions: { flexDirection: 'row', gap: 4 },
  actionBtn: { padding: 4 },
  empty: { alignItems: 'center', paddingTop: 48 },
  emptyText: { marginTop: 8, color: '#9ca3af', fontSize: 14 },
  completedSection: {
    paddingHorizontal: 16,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    marginTop: 8,
  },
  completedTitle: { fontSize: 12, color: '#9ca3af', marginBottom: 8, paddingTop: 8 },
});
