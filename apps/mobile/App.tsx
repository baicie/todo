import { useCallback, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  useAuth,
  useCreateTask,
  useDeleteTask,
  useList,
  useTask,
  useToggleComplete,
  useToggleImportant,
  useToggleMyDay,
} from '@baicie/orbit-hooks';
import type { Task } from '@baicie/orbit';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

type TabType = 'my-day' | 'important' | 'planned' | 'tasks' | string;

export default function AppWrapper() {
  return (
    <QueryClientProvider client={queryClient}>
      <MainContent />
    </QueryClientProvider>
  );
}

function MainContent() {
  const { user, isLoading: authLoading, logout } = useAuth();
  const [activeTab, setActiveTab] = useState<TabType>('my-day');
  const [newTask, setNewTask] = useState('');
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [isAddingTask, setIsAddingTask] = useState(false);

  // Build filter based on active tab
  const getFilter = useCallback(() => {
    switch (activeTab) {
      case 'my-day':
        return { addToMyDay: true };
      case 'important':
        return { isImportant: true };
      case 'tasks':
        return {};
      default:
        return {};
    }
  }, [activeTab]);

  const { data: tasks = [], isLoading: tasksLoading } = useTask(getFilter());
  const { data: customLists = [] } = useList();
  const createTaskMutation = useCreateTask();
  const deleteTaskMutation = useDeleteTask();
  const toggleCompleteMutation = useToggleComplete();
  const toggleImportantMutation = useToggleImportant();
  const toggleMyDayMutation = useToggleMyDay();
  const { login, register } = useAuth();
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authName, setAuthName] = useState('');
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authLoadingState, setAuthLoadingState] = useState(false);
  const [authError, setAuthError] = useState('');

  const handleAuth = async () => {
    setAuthLoadingState(true);
    setAuthError('');
    try {
      if (authMode === 'login') {
        await login(authEmail, authPassword);
      } else {
        await register(authName, authEmail, authPassword);
      }
      setShowAuthModal(false);
    } catch (err: unknown) {
      const e = err as { message?: string };
      setAuthError(e.message || '认证失败');
    } finally {
      setAuthLoadingState(false);
    }
  };

  const handleAddTask = useCallback(() => {
    if (!newTask.trim()) return;
    createTaskMutation.mutate(
      {
        title: newTask.trim(),
        addToMyDay: activeTab === 'my-day',
      },
      {
        onSuccess: () => {
          setNewTask('');
          setIsAddingTask(false);
        },
      },
    );
  }, [newTask, activeTab, createTaskMutation]);

  const handleToggleComplete = useCallback(
    (task: Task) => {
      toggleCompleteMutation(task);
    },
    [toggleCompleteMutation],
  );

  const handleToggleImportant = useCallback(
    (task: Task) => {
      toggleImportantMutation(task);
    },
    [toggleImportantMutation],
  );

  const handleToggleMyDay = useCallback(
    (task: Task) => {
      toggleMyDayMutation(task);
    },
    [toggleMyDayMutation],
  );

  const handleDeleteTask = useCallback(
    (taskId: string) => {
      Alert.alert('删除任务', '确定要删除这个任务吗？', [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: () => deleteTaskMutation.mutate(taskId),
        },
      ]);
    },
    [deleteTaskMutation],
  );

  const handleLogout = useCallback(() => {
    Alert.alert('退出登录', '确定要退出登录吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '退出',
        style: 'destructive',
        onPress: () => logout(),
      },
    ]);
  }, [logout]);

  const activeTasks = tasks.filter((t) => !t.isCompleted);
  const completedTasks = tasks.filter((t) => t.isCompleted);

  const getTabLabel = (tab: TabType): string => {
    switch (tab) {
      case 'my-day':
        return '我的一天';
      case 'important':
        return '重要';
      case 'planned':
        return '已计划';
      case 'tasks':
        return '任务';
      default:
        return '任务';
    }
  };

  const getTabIcon = (tab: TabType): keyof typeof Ionicons.glyphMap => {
    switch (tab) {
      case 'my-day':
        return 'sunny';
      case 'important':
        return 'star';
      case 'planned':
        return 'calendar';
      case 'tasks':
        return 'list';
      default:
        return 'list';
    }
  };

  const tabs: TabType[] = ['my-day', 'important', 'planned', 'tasks'];

  const renderTaskItem = ({ item }: { item: Task }) => (
    <View style={styles.taskItem}>
      <TouchableOpacity onPress={() => handleToggleComplete(item)} style={styles.taskLeft}>
        <View style={[styles.checkbox, item.isCompleted && styles.checkboxDone]}>
          {item.isCompleted && <Ionicons name="checkmark" size={14} color="#fff" />}
        </View>
        <View style={styles.taskContent}>
          <Text
            style={[styles.taskTitle, item.isCompleted && styles.taskTitleDone]}
            numberOfLines={2}
          >
            {item.title}
          </Text>
          {item.dueDate && (
            <Text style={styles.taskDue}>
              <Ionicons name="calendar-outline" size={10} color="#9ca3af" />{' '}
              {new Date(item.dueDate).toLocaleDateString('zh-CN')}
            </Text>
          )}
          {item.steps.length > 0 && (
            <Text style={styles.taskSteps}>
              <Ionicons name="checkbox-outline" size={10} color="#9ca3af" />{' '}
              {item.steps.filter((s) => s.isCompleted).length}/{item.steps.length}
            </Text>
          )}
        </View>
      </TouchableOpacity>

      <View style={styles.taskActions}>
        <TouchableOpacity onPress={() => handleToggleMyDay(item)} style={styles.actionBtn}>
          <Ionicons
            name={item.addToMyDay ? 'sunny' : 'sunny-outline'}
            size={20}
            color={item.addToMyDay ? '#f59e0b' : '#9ca3af'}
          />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => handleToggleImportant(item)} style={styles.actionBtn}>
          <Ionicons
            name={item.isImportant ? 'star' : 'star-outline'}
            size={20}
            color={item.isImportant ? '#f59e0b' : '#9ca3af'}
          />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setSelectedTask(item)} style={styles.actionBtn}>
          <Ionicons name="ellipsis-horizontal" size={20} color="#9ca3af" />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => handleDeleteTask(item.id)} style={styles.actionBtn}>
          <Ionicons name="trash-outline" size={18} color="#f87171" />
        </TouchableOpacity>
      </View>
    </View>
  );

  // Auth loading screen
  if (authLoading) {
    return (
      <SafeAreaView style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#3b82f6" />
        <Text style={styles.loadingText}>加载中...</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="dark-content" />

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.appTitle}>Orbit</Text>
        <View style={styles.headerActions}>
          <TouchableOpacity onPress={() => setShowAuthModal(true)} style={styles.headerBtn}>
            <Ionicons
              name={user ? 'person-circle' : 'person-circle-outline'}
              size={28}
              color={user ? '#3b82f6' : '#9ca3af'}
            />
          </TouchableOpacity>
        </View>
      </View>

      {/* Tabs */}
      <View style={styles.tabs}>
        {tabs.map((tab) => (
          <TouchableOpacity
            key={tab}
            style={[styles.tab, activeTab === tab && styles.tabActive]}
            onPress={() => setActiveTab(tab)}
          >
            <Ionicons
              name={getTabIcon(tab)}
              size={16}
              color={activeTab === tab ? '#3b82f6' : '#9ca3af'}
            />
            <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
              {getTabLabel(tab)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Custom Lists */}
      {customLists.length > 0 && (
        <View style={styles.customLists}>
          {customLists.map((list) => (
            <TouchableOpacity
              key={list.id}
              style={[styles.listChip, activeTab === list.id && styles.listChipActive]}
              onPress={() => setActiveTab(list.id)}
            >
              <Text
                style={[styles.listChipText, activeTab === list.id && styles.listChipTextActive]}
              >
                {list.title}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Add Task */}
      {isAddingTask ? (
        <View style={styles.addTask}>
          <TouchableOpacity onPress={handleAddTask} style={styles.addButton}>
            <Ionicons name="add" size={24} color="#3b82f6" />
          </TouchableOpacity>
          <TextInput
            value={newTask}
            onChangeText={setNewTask}
            placeholder="添加任务..."
            style={styles.input}
            placeholderTextColor="#9ca3af"
            autoFocus
            onSubmitEditing={handleAddTask}
            returnKeyType="done"
          />
          <TouchableOpacity onPress={() => setIsAddingTask(false)}>
            <Ionicons name="close" size={20} color="#9ca3af" />
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity style={styles.addTaskButton} onPress={() => setIsAddingTask(true)}>
          <Ionicons name="add" size={20} color="#3b82f6" />
          <Text style={styles.addTaskText}>添加任务</Text>
        </TouchableOpacity>
      )}

      {/* Task List */}
      {tasksLoading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="small" color="#3b82f6" />
        </View>
      ) : (
        <FlatList
          data={activeTasks}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          renderItem={renderTaskItem}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="clipboard-outline" size={48} color="#e5e7eb" />
              <Text style={styles.emptyText}>暂无任务</Text>
              <Text style={styles.emptySubtext}>点击上方「添加任务」开始</Text>
            </View>
          }
          ListFooterComponent={
            completedTasks.length > 0 ? (
              <View style={styles.completedSection}>
                <Text style={styles.completedTitle}>已完成 ({completedTasks.length})</Text>
                {completedTasks.map((task) => (
                  <View key={task.id} style={styles.taskItem}>
                    <TouchableOpacity
                      onPress={() => handleToggleComplete(task)}
                      style={styles.taskLeft}
                    >
                      <View style={[styles.checkbox, styles.checkboxDone]}>
                        <Ionicons name="checkmark" size={14} color="#fff" />
                      </View>
                      <Text style={[styles.taskTitle, styles.taskTitleDone]} numberOfLines={2}>
                        {task.title}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => handleDeleteTask(task.id)}
                      style={styles.actionBtn}
                    >
                      <Ionicons name="trash-outline" size={18} color="#f87171" />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            ) : null
          }
        />
      )}

      {/* Task Detail Modal */}
      <Modal
        visible={selectedTask !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setSelectedTask(null)}
      >
        <SafeAreaView style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={() => setSelectedTask(null)}>
              <Ionicons name="close" size={24} color="#374151" />
            </TouchableOpacity>
            <Text style={styles.modalTitle}>任务详情</Text>
            <View style={{ width: 24 }} />
          </View>

          {selectedTask && (
            <View style={styles.modalContent}>
              <Text style={styles.detailTitle}>{selectedTask.title}</Text>
              {selectedTask.description && (
                <Text style={styles.detailDescription}>{selectedTask.description}</Text>
              )}

              <View style={styles.detailRow}>
                <Ionicons name="star" size={18} color="#f59e0b" />
                <Text style={styles.detailLabel}>重要</Text>
                <TouchableOpacity
                  onPress={() => {
                    handleToggleImportant(selectedTask);
                    setSelectedTask({
                      ...selectedTask,
                      isImportant: !selectedTask.isImportant,
                    });
                  }}
                >
                  <Text style={styles.detailAction}>
                    {selectedTask.isImportant ? '取消' : '标记'}
                  </Text>
                </TouchableOpacity>
              </View>

              <View style={styles.detailRow}>
                <Ionicons name="sunny" size={18} color="#f59e0b" />
                <Text style={styles.detailLabel}>我的一天</Text>
                <TouchableOpacity
                  onPress={() => {
                    handleToggleMyDay(selectedTask);
                    setSelectedTask({
                      ...selectedTask,
                      addToMyDay: !selectedTask.addToMyDay,
                    });
                  }}
                >
                  <Text style={styles.detailAction}>
                    {selectedTask.addToMyDay ? '移除' : '添加'}
                  </Text>
                </TouchableOpacity>
              </View>

              <TouchableOpacity
                style={styles.deleteButton}
                onPress={() => {
                  handleDeleteTask(selectedTask.id);
                  setSelectedTask(null);
                }}
              >
                <Ionicons name="trash-outline" size={18} color="#fff" />
                <Text style={styles.deleteButtonText}>删除任务</Text>
              </TouchableOpacity>
            </View>
          )}
        </SafeAreaView>
      </Modal>

      {/* Auth Modal */}
      <Modal
        visible={showAuthModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowAuthModal(false)}
      >
        <SafeAreaView style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={() => setShowAuthModal(false)}>
              <Ionicons name="close" size={24} color="#374151" />
            </TouchableOpacity>
            <Text style={styles.modalTitle}>
              {user ? '账户' : authMode === 'login' ? '登录' : '注册'}
            </Text>
            <View style={{ width: 24 }} />
          </View>

          <View style={styles.modalContent}>
            {user ? (
              <>
                <View style={styles.userInfo}>
                  <View style={styles.userAvatar}>
                    <Text style={styles.userAvatarText}>
                      {user.name?.charAt(0)?.toUpperCase() || 'U'}
                    </Text>
                  </View>
                  <Text style={styles.userName}>{user.name}</Text>
                  <Text style={styles.userEmail}>{user.email}</Text>
                </View>
                <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
                  <Text style={styles.logoutButtonText}>退出登录</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <View style={styles.authTabs}>
                  <TouchableOpacity
                    style={[styles.authTab, authMode === 'login' && styles.authTabActive]}
                    onPress={() => setAuthMode('login')}
                  >
                    <Text
                      style={[styles.authTabText, authMode === 'login' && styles.authTabTextActive]}
                    >
                      登录
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.authTab, authMode === 'register' && styles.authTabActive]}
                    onPress={() => setAuthMode('register')}
                  >
                    <Text
                      style={[
                        styles.authTabText,
                        authMode === 'register' && styles.authTabTextActive,
                      ]}
                    >
                      注册
                    </Text>
                  </TouchableOpacity>
                </View>

                {authError ? <Text style={styles.authError}>{authError}</Text> : null}

                {authMode === 'register' && (
                  <TextInput
                    placeholder="用户名"
                    value={authName}
                    onChangeText={setAuthName}
                    style={styles.authInput}
                    placeholderTextColor="#9ca3af"
                  />
                )}

                <TextInput
                  placeholder="邮箱"
                  value={authEmail}
                  onChangeText={setAuthEmail}
                  style={styles.authInput}
                  placeholderTextColor="#9ca3af"
                  keyboardType="email-address"
                  autoCapitalize="none"
                />

                <TextInput
                  placeholder="密码"
                  value={authPassword}
                  onChangeText={setAuthPassword}
                  style={styles.authInput}
                  placeholderTextColor="#9ca3af"
                  secureTextEntry
                />

                <TouchableOpacity
                  style={styles.authButton}
                  onPress={handleAuth}
                  disabled={authLoadingState}
                >
                  {authLoadingState ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={styles.authButtonText}>
                      {authMode === 'login' ? '登录' : '注册'}
                    </Text>
                  )}
                </TouchableOpacity>
              </>
            )}
          </View>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f8fafc',
  },
  loadingText: { marginTop: 8, color: '#9ca3af', fontSize: 14 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  appTitle: { fontSize: 24, fontWeight: '700', color: '#3b82f6' },
  headerActions: { flexDirection: 'row', gap: 8 },
  headerBtn: { padding: 4 },
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
  customLists: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    marginBottom: 8,
    flexWrap: 'wrap',
    gap: 6,
  },
  listChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: '#f1f5f9',
  },
  listChipActive: { backgroundColor: '#dbeafe' },
  listChipText: { fontSize: 12, color: '#64748b' },
  listChipTextActive: { color: '#3b82f6', fontWeight: '600' },
  addTaskButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderStyle: 'dashed',
  },
  addTaskText: { fontSize: 14, color: '#3b82f6', fontWeight: '500' },
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
  list: { paddingHorizontal: 16, paddingBottom: 24 },
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
  taskContent: { flex: 1 },
  taskTitle: { flex: 1, fontSize: 15, color: '#111827' },
  taskTitleDone: {
    textDecorationLine: 'line-through',
    color: '#9ca3af',
  },
  taskDue: { fontSize: 11, color: '#9ca3af', marginTop: 2 },
  taskSteps: { fontSize: 11, color: '#9ca3af', marginTop: 2 },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: '#d1d5db',
  },
  checkboxDone: {
    backgroundColor: '#3b82f6',
    borderColor: '#3b82f6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  taskActions: { flexDirection: 'row', gap: 2 },
  actionBtn: { padding: 4 },
  empty: { alignItems: 'center', paddingTop: 48 },
  emptyText: { marginTop: 8, color: '#9ca3af', fontSize: 14 },
  emptySubtext: { marginTop: 4, color: '#d1d5db', fontSize: 12 },
  completedSection: {
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    marginTop: 8,
  },
  completedTitle: {
    fontSize: 12,
    color: '#9ca3af',
    marginBottom: 8,
    paddingTop: 8,
  },
  // Modal styles
  modalContainer: { flex: 1, backgroundColor: '#fff' },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  modalTitle: { fontSize: 17, fontWeight: '600', color: '#111827' },
  modalContent: { padding: 16 },
  detailTitle: { fontSize: 20, fontWeight: '600', color: '#111827', marginBottom: 12 },
  detailDescription: { fontSize: 15, color: '#6b7280', marginBottom: 16, lineHeight: 22 },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
    gap: 12,
  },
  detailLabel: { flex: 1, fontSize: 15, color: '#374151' },
  detailAction: { fontSize: 15, color: '#3b82f6', fontWeight: '500' },
  deleteButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#ef4444',
    paddingVertical: 14,
    borderRadius: 10,
    marginTop: 24,
  },
  deleteButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  // Auth modal
  userInfo: { alignItems: 'center', paddingVertical: 24 },
  userAvatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#3b82f6',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  userAvatarText: { fontSize: 24, color: '#fff', fontWeight: '700' },
  userName: { fontSize: 18, fontWeight: '600', color: '#111827' },
  userEmail: { fontSize: 14, color: '#6b7280', marginTop: 4 },
  logoutButton: {
    backgroundColor: '#ef4444',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  logoutButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  authTabs: { flexDirection: 'row', marginBottom: 20 },
  authTab: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: '#e5e7eb',
  },
  authTabActive: { borderBottomColor: '#3b82f6' },
  authTabText: { fontSize: 16, color: '#9ca3af', fontWeight: '500' },
  authTabTextActive: { color: '#3b82f6', fontWeight: '600' },
  authError: { color: '#ef4444', fontSize: 13, marginBottom: 12, textAlign: 'center' },
  authInput: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: '#111827',
    marginBottom: 12,
  },
  authButton: {
    backgroundColor: '#3b82f6',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 4,
  },
  authButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
