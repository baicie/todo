import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';

interface ShortcutItem {
  keys: string[];
  label: string;
}

interface ShortcutGroup {
  title: string;
  shortcuts: ShortcutItem[];
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const mod = isMac ? '⌘' : 'Ctrl';

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[1.4rem] h-6 px-1.5 text-xs font-mono font-medium bg-gray-100 border border-gray-200 rounded text-gray-600 shadow-sm">
      {children}
    </kbd>
  );
}

const shortcutGroups: ShortcutGroup[] = [
  {
    title: '全局',
    shortcuts: [
      { keys: [mod, 'K'], label: '打开命令面板' },
      { keys: [mod, ','], label: '打开设置' },
      { keys: [mod, 'Shift', 'F'], label: '搜索' },
      { keys: [mod, 'Shift', 'N'], label: '新建任务' },
      { keys: ['?'], label: '快捷键帮助' },
      { keys: ['Esc'], label: '取消 / 关闭' },
    ],
  },
  {
    title: '导航',
    shortcuts: [
      { keys: ['↑', '↓'], label: '上下选择任务' },
      { keys: ['Tab', 'Shift+Tab'], label: '上一个 / 下一个' },
      { keys: ['1'], label: '我的一天' },
      { keys: ['2'], label: '重要' },
      { keys: ['3'], label: '已计划' },
      { keys: ['4'], label: '所有任务' },
      { keys: ['L'], label: '切换侧边栏' },
    ],
  },
  {
    title: '任务操作',
    shortcuts: [
      { keys: ['N'], label: '新建任务' },
      { keys: ['Enter', 'E'], label: '打开任务详情' },
      { keys: ['Space'], label: '切换完成' },
      { keys: ['I'], label: '切换重要' },
      { keys: ['M'], label: '加入我的一天' },
      { keys: [mod, 'D'], label: '复制任务' },
      { keys: ['Del'], label: '删除任务' },
    ],
  },
];

interface ShortcutsHelpProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ShortcutsHelp({ isOpen, onClose }: ShortcutsHelpProps) {
  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-50 flex items-center justify-center"
          onClick={onClose}
        >
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" aria-hidden="true" />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="relative bg-white rounded-2xl shadow-2xl w-full max-w-2xl mx-4 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 className="text-lg font-semibold text-gray-900">键盘快捷键</h2>
              <button
                onClick={onClose}
                className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
                aria-label="关闭"
              >
                <X size={18} />
              </button>
            </div>

            <div className="max-h-[60vh] overflow-y-auto p-6">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-8">
                {shortcutGroups.map((group) => (
                  <div key={group.title}>
                    <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
                      {group.title}
                    </h3>
                    <div className="space-y-2.5">
                      {group.shortcuts.map((shortcut, idx) => (
                        <div key={idx} className="flex items-center justify-between gap-4">
                          <span className="text-sm text-gray-600 truncate">{shortcut.label}</span>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            {shortcut.keys.map((key, ki) => (
                              <span key={ki} className="flex items-center">
                                <Kbd>{key}</Kbd>
                                {ki < shortcut.keys.length - 1 && (
                                  <span className="mx-0.5 text-gray-300 text-xs">+</span>
                                )}
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="px-6 py-3 border-t border-gray-100 bg-gray-50 text-center text-xs text-gray-400">
              按 <Kbd>?</Kbd> 或 <Kbd>Esc</Kbd> 关闭
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
