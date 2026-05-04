import { Calendar, CheckCircle2, Circle, Link, List, Star, Sun, UserPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { toast } from 'react-hot-toast';
import { type ShareViewData, buildShareUrl, getShareView } from '../lib/share';

function formatDueDate(dateStr: string | null): string | null {
  if (!dateStr) return null;
  const date = new Date(dateStr);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const isToday = date.toDateString() === today.toDateString();
  const isTomorrow = date.toDateString() === tomorrow.toDateString();
  const isPast = date < today && !isToday;

  if (isToday) return '今天';
  if (isTomorrow) return '明天';
  if (isPast) return `逾期 ${date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}`;
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

function getDueDateClass(dateStr: string | null): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isPast = date < today && date.toDateString() !== today.toDateString();
  if (isPast) return 'text-red-500';
  if (date.toDateString() === today.toDateString()) return 'text-amber-500';
  if (date.toDateString() === tomorrow.toDateString()) return 'text-blue-500';
  return 'text-gray-400';
}

function TaskItem({ task }: { task: ShareViewData['tasks'][number] }) {
  return (
    <div className="flex items-start gap-3 px-4 py-3 hover:bg-gray-50 transition-colors">
      <div className="flex-shrink-0 mt-0.5">
        {task.isCompleted ? (
          <CheckCircle2 size={18} className="text-green-500" />
        ) : (
          <Circle size={18} className="text-gray-300" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p
          className={`text-sm ${task.isCompleted ? 'line-through text-gray-400' : 'text-gray-800'} font-medium`}
        >
          {task.title}
        </p>
        <div className="flex items-center gap-3 mt-1">
          {task.dueDate && (
            <span className={`flex items-center gap-1 text-xs ${getDueDateClass(task.dueDate)}`}>
              <Calendar size={11} />
              {formatDueDate(task.dueDate)}
            </span>
          )}
          {task.myDay && (
            <span className="flex items-center gap-1 text-xs text-amber-500">
              <Sun size={11} />
              我的一天
            </span>
          )}
        </div>
      </div>
      {task.isImportant && <Star size={14} className="text-amber-400 flex-shrink-0 mt-0.5" />}
    </div>
  );
}

export function ShareView() {
  const { shareCode } = useParams<{ shareCode: string }>();
  const [isLoading, setIsLoading] = useState(true);
  const [isCopied, setIsCopied] = useState(false);
  const [shareData, setShareData] = useState<ShareViewData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadShare = async () => {
      if (!shareCode) {
        setError('分享码无效');
        setIsLoading(false);
        return;
      }
      try {
        const data = await getShareView(shareCode);
        setShareData(data);
      } catch {
        setError('分享不存在或已过期');
      } finally {
        setIsLoading(false);
      }
    };

    void loadShare();
  }, [shareCode]);

  const handleCopyLink = async () => {
    if (!shareCode) return;
    await navigator.clipboard.writeText(buildShareUrl(shareCode));
    setIsCopied(true);
    toast.success('链接已复制');
    setTimeout(() => setIsCopied(false), 2000);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-gray-500">加载分享内容...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center max-w-md mx-auto px-4">
          <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <Link size={32} className="text-red-500" />
          </div>
          <h1 className="text-xl font-semibold text-gray-900 mb-2">无法加载分享</h1>
          <p className="text-gray-500 mb-6">{error}</p>
          <a
            href="/"
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
          >
            前往首页
          </a>
        </div>
      </div>
    );
  }

  const completedCount = shareData?.tasks.filter((t) => t.isCompleted).length ?? 0;
  const totalCount = shareData?.tasks.length ?? 0;
  const importantCount = shareData?.tasks.filter((t) => t.isImportant).length ?? 0;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 shadow-sm sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-500 rounded-lg flex items-center justify-center">
              <List size={20} className="text-white" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-gray-900">{shareData?.list.title}</h1>
              <p className="text-xs text-gray-500 flex items-center gap-1">
                <UserPlus size={12} />
                来自 Orbit 分享
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div
              className={`px-2.5 py-1 rounded-full text-xs font-medium hidden sm:block ${
                shareData?.permission === 'edit' || shareData?.permission === 'admin'
                  ? 'bg-amber-100 text-amber-700'
                  : 'bg-gray-100 text-gray-600'
              }`}
            >
              {shareData?.permission === 'edit' || shareData?.permission === 'admin'
                ? '可编辑'
                : '仅查看'}
            </div>
            <button
              onClick={handleCopyLink}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                isCopied
                  ? 'bg-green-100 text-green-700'
                  : 'bg-blue-500 text-white hover:bg-blue-600'
              }`}
            >
              <Link size={14} />
              {isCopied ? '已复制' : '复制链接'}
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-2xl mx-auto px-4 py-6">
        {/* Stats */}
        {totalCount > 0 && (
          <div className="grid grid-cols-3 gap-3 mb-6">
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 text-center">
              <div className="text-2xl font-bold text-gray-900">{totalCount}</div>
              <div className="text-xs text-gray-500 mt-1">全部任务</div>
            </div>
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 text-center">
              <div className="text-2xl font-bold text-green-600">{completedCount}</div>
              <div className="text-xs text-gray-500 mt-1">已完成</div>
            </div>
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 text-center">
              <div className="text-2xl font-bold text-amber-500">{importantCount}</div>
              <div className="text-xs text-gray-500 mt-1">重要</div>
            </div>
          </div>
        )}

        {/* Task List */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          {totalCount === 0 ? (
            <div className="py-16 text-center">
              <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <List size={32} className="text-gray-300" />
              </div>
              <h2 className="text-lg font-medium text-gray-700 mb-2">清单为空</h2>
              <p className="text-sm text-gray-400">这个清单还没有任何任务</p>
            </div>
          ) : (
            <>
              {/* My Day Section */}
              {shareData?.tasks.some((t) => t.myDay) && (
                <div>
                  <div className="px-4 py-2 bg-amber-50 border-b border-amber-100 flex items-center gap-2">
                    <Sun size={14} className="text-amber-500" />
                    <span className="text-xs font-medium text-amber-700">我的一天</span>
                  </div>
                  {shareData.tasks
                    .filter((t) => t.myDay)
                    .map((task) => (
                      <TaskItem key={task.id} task={task} />
                    ))}
                </div>
              )}

              {/* Important Section */}
              {shareData?.tasks.some((t) => t.isImportant && !t.myDay) && (
                <div>
                  <div className="px-4 py-2 bg-amber-50 border-b border-amber-100 border-t border-gray-100 flex items-center gap-2">
                    <Star size={14} className="text-amber-500" />
                    <span className="text-xs font-medium text-amber-700">重要</span>
                  </div>
                  {shareData.tasks
                    .filter((t) => t.isImportant && !t.myDay)
                    .map((task) => (
                      <TaskItem key={task.id} task={task} />
                    ))}
                </div>
              )}

              {/* Remaining Tasks */}
              {shareData?.tasks.some((t) => !t.isImportant && !t.myDay) && (
                <div>
                  {shareData.tasks.some((t) => t.isImportant || t.myDay) && (
                    <div className="px-4 py-2 border-t border-gray-100 bg-gray-50">
                      <span className="text-xs font-medium text-gray-400">其他任务</span>
                    </div>
                  )}
                  {shareData.tasks
                    .filter((t) => !t.isImportant && !t.myDay)
                    .map((task) => (
                      <TaskItem key={task.id} task={task} />
                    ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* CTA */}
        <div className="mt-8 text-center">
          <p className="text-sm text-gray-500 mb-3">
            通过 <span className="font-medium text-gray-700">Orbit</span> 管理你的所有任务
          </p>
          <a
            href="/login"
            className="inline-flex items-center gap-2 px-6 py-3 bg-blue-500 text-white rounded-xl hover:bg-blue-600 transition-colors font-medium shadow-sm"
          >
            登录 Orbit 查看完整内容
          </a>
          <p className="text-xs text-gray-400 mt-3">
            还没有账号？
            <a href="/register" className="text-blue-500 hover:underline ml-1">
              立即注册
            </a>
          </p>
        </div>

        {/* Feature Highlights */}
        <div className="mt-10 grid grid-cols-3 gap-4">
          {[
            {
              icon: Sun,
              title: '我的一天',
              desc: '专注今日任务',
              color: 'text-amber-500',
              bg: 'bg-amber-50',
            },
            {
              icon: Star,
              title: '重要任务',
              desc: '标记关键事项',
              color: 'text-amber-500',
              bg: 'bg-amber-50',
            },
            {
              icon: Calendar,
              title: '截止日期',
              desc: '设置提醒',
              color: 'text-blue-500',
              bg: 'bg-blue-50',
            },
          ].map(({ icon: Icon, title, desc, color, bg }) => (
            <div
              key={title}
              className="bg-white rounded-xl shadow-sm border border-gray-200 p-5 text-center hover:shadow-md transition-shadow"
            >
              <div
                className={`w-12 h-12 ${bg} rounded-xl flex items-center justify-center mx-auto mb-3`}
              >
                <Icon size={24} className={color} />
              </div>
              <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
              <p className="text-xs text-gray-500 mt-1">{desc}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
