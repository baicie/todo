import { Copy, Globe, Link, Trash2, X } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { useState } from 'react';
import { toast } from 'react-hot-toast';
import {
  type CreateShareInput,
  type Share,
  buildShareUrl,
  createShare,
  deleteShare,
  getMyShares,
  updateShare,
} from '../lib/share';

interface ShareDialogProps {
  isOpen: boolean;
  onClose: () => void;
  listId: string;
  listTitle: string;
}

type PermissionOption = 'view' | 'edit';

const PERMISSION_LABELS: Record<PermissionOption, string> = {
  view: '仅查看',
  edit: '可编辑',
};

export function ShareDialog({ isOpen, onClose, listId, listTitle }: ShareDialogProps) {
  const [shares, setShares] = useState<Share[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedPermission, setSelectedPermission] = useState<PermissionOption>('view');
  const [isCreating, setIsCreating] = useState(false);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  const loadShares = async () => {
    if (!isOpen) return;
    setIsLoading(true);
    try {
      const data = await getMyShares();
      setShares(data.filter((s) => s.listId === listId));
    } catch {
      // 未登录或网络错误
    } finally {
      setIsLoading(false);
    }
  };

  if (isOpen && shares.length === 0 && !isLoading) {
    void loadShares();
  }

  const handleCreateShare = async () => {
    setIsCreating(true);
    try {
      const input: CreateShareInput = {
        listId,
        title: listTitle,
        permission: selectedPermission,
      };
      const newShare = await createShare(input);
      setShares((prev) => [...prev, newShare]);
      void navigator.clipboard.writeText(buildShareUrl(newShare.shareCode));
      toast.success('分享链接已复制到剪贴板');
    } catch {
      toast.error('创建分享失败，请先登录');
    } finally {
      setIsCreating(false);
    }
  };

  const handleCopyLink = async (shareCode: string) => {
    const url = buildShareUrl(shareCode);
    await navigator.clipboard.writeText(url);
    setCopiedCode(shareCode);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  const handleTogglePermission = async (share: Share) => {
    const newPermission = share.permission === 'view' ? 'edit' : 'view';
    try {
      const updated = await updateShare(share.id, { permission: newPermission });
      setShares((prev) => prev.map((s) => (s.id === share.id ? updated : s)));
    } catch {
      toast.error('更新失败');
    }
  };

  const handleDelete = async (shareId: string) => {
    try {
      await deleteShare(shareId);
      setShares((prev) => prev.filter((s) => s.id !== shareId));
    } catch {
      toast.error('删除失败');
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/30 z-50"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none"
          >
            <div
              className="bg-white rounded-xl shadow-2xl w-full max-w-md pointer-events-auto overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-blue-50 rounded-lg">
                    <Link size={18} className="text-blue-600" />
                  </div>
                  <div>
                    <h2 className="text-base font-semibold text-gray-900">分享清单</h2>
                    <p className="text-xs text-gray-500 truncate max-w-[200px]">{listTitle}</p>
                  </div>
                </div>
                <button
                  onClick={onClose}
                  className="p-2 hover:bg-gray-100 rounded-lg transition-colors text-gray-400 hover:text-gray-600"
                >
                  <X size={18} />
                </button>
              </div>

              {/* Body */}
              <div className="p-6 space-y-5">
                {/* Create new share */}
                <div className="space-y-3">
                  <label className="block text-sm font-medium text-gray-700">创建分享链接</label>
                  <div className="flex items-center gap-2">
                    <select
                      value={selectedPermission}
                      onChange={(e) => setSelectedPermission(e.target.value as PermissionOption)}
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white text-gray-900"
                    >
                      <option value="view">{PERMISSION_LABELS.view}</option>
                      <option value="edit">{PERMISSION_LABELS.edit}</option>
                    </select>
                    <button
                      onClick={() => void handleCreateShare()}
                      disabled={isCreating}
                      className="px-4 py-2 bg-blue-500 text-white text-sm font-medium rounded-lg hover:bg-blue-600 transition-colors disabled:opacity-50 flex items-center gap-2"
                    >
                      <Globe size={14} />
                      {isCreating ? '创建中...' : '分享'}
                    </button>
                  </div>
                </div>

                {/* Existing shares */}
                {isLoading ? (
                  <div className="text-center py-6 text-sm text-gray-400">加载中...</div>
                ) : shares.length > 0 ? (
                  <div className="space-y-2">
                    <label className="block text-sm font-medium text-gray-700">
                      现有分享链接 ({shares.length})
                    </label>
                    <div className="space-y-2 max-h-48 overflow-y-auto">
                      {shares.map((share) => (
                        <div
                          key={share.id}
                          className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg border border-gray-100"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <code className="text-xs bg-gray-200 px-1.5 py-0.5 rounded font-mono text-gray-600">
                                {share.shareCode}
                              </code>
                              <span className="text-xs text-gray-500">
                                {PERMISSION_LABELS[share.permission as PermissionOption] ??
                                  share.permission}
                              </span>
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => void handleCopyLink(share.shareCode)}
                              className="p-1.5 hover:bg-gray-200 rounded transition-colors text-gray-500 hover:text-blue-600"
                              title="复制链接"
                            >
                              {copiedCode === share.shareCode ? (
                                <span className="text-xs text-green-600 font-medium">已复制</span>
                              ) : (
                                <Copy size={14} />
                              )}
                            </button>
                            <button
                              onClick={() => void handleTogglePermission(share)}
                              className="p-1.5 hover:bg-gray-200 rounded transition-colors text-gray-500 hover:text-amber-600"
                              title={`切换为${share.permission === 'view' ? '可编辑' : '仅查看'}`}
                            >
                              <Globe size={14} />
                            </button>
                            <button
                              onClick={() => void handleDelete(share.id)}
                              className="p-1.5 hover:bg-red-50 rounded transition-colors text-gray-400 hover:text-red-500"
                              title="删除分享"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-4 text-sm text-gray-400">暂无分享链接</div>
                )}
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
