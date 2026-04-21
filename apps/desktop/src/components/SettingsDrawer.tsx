import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface SettingsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsDrawer({ isOpen, onClose }: SettingsDrawerProps) {
  const { t } = useTranslation();

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/20 z-20"
          />
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className="fixed top-0 right-0 w-full max-w-sm h-full bg-white shadow-xl z-30 flex flex-col"
          >
            <div className="px-4 py-4 border-b border-gray-200 flex items-center justify-between">
              <h2 className="text-lg font-bold text-gray-900">设置</h2>
              <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
                <X size={20} className="text-gray-500" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-6">
              <section>
                <h3 className="text-sm font-semibold text-gray-500 mb-3">主题</h3>
                <div className="space-y-2">
                  {['浅色', '深色', '跟随系统'].map((theme) => (
                    <button
                      key={theme}
                      className="w-full text-left px-3 py-2 text-sm rounded hover:bg-gray-100 text-gray-700"
                    >
                      {theme}
                    </button>
                  ))}
                </div>
              </section>
              <section>
                <h3 className="text-sm font-semibold text-gray-500 mb-3">通知</h3>
                <label className="flex items-center gap-3">
                  <input type="checkbox" className="w-4 h-4" />
                  <span className="text-sm text-gray-700">启用任务到期提醒</span>
                </label>
              </section>
              <section>
                <h3 className="text-sm font-semibold text-gray-500 mb-3">账号</h3>
                <button className="w-full text-left px-3 py-2 text-sm rounded hover:bg-gray-100 text-gray-700">
                  退出登录
                </button>
              </section>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
