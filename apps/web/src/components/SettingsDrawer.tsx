import { Bell, HelpCircle, Info, Monitor, Moon, Shield, Sun, X } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

interface SettingsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

export const SettingsDrawer = ({ isOpen, onClose }: SettingsDrawerProps) => {
  const { t } = useTranslation();

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/20 z-40"
          />

          {/* Drawer */}
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className="fixed right-0 top-0 bottom-0 w-[360px] bg-white shadow-2xl z-50 flex flex-col"
          >
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">{t('settings.title')}</h2>
              <button
                onClick={onClose}
                className="p-2 hover:bg-gray-100 rounded-md transition-colors text-gray-500"
              >
                <X size={20} />
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-4 space-y-6">
              {/* General */}
              <section>
                <h3 className="text-sm font-medium text-gray-900 mb-3">{t('settings.general')}</h3>
                <div className="space-y-2">
                  <div className="flex items-center justify-between p-3 rounded-md hover:bg-gray-50 cursor-pointer transition-colors">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-blue-50 rounded-md text-blue-600">
                        <Sun size={18} />
                      </div>
                      <span className="text-sm text-gray-700">{t('settings.theme')}</span>
                    </div>
                    <span className="text-xs text-gray-400">{t('settings.systemDefault')}</span>
                  </div>

                  <div className="flex items-center justify-between p-3 rounded-md hover:bg-gray-50 cursor-pointer transition-colors">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-purple-50 rounded-md text-purple-600">
                        <Bell size={18} />
                      </div>
                      <span className="text-sm text-gray-700">{t('settings.notifications')}</span>
                    </div>
                    <div className="w-8 h-4 bg-gray-200 rounded-full relative">
                      <div className="w-4 h-4 bg-white rounded-full shadow-sm absolute left-0 top-0 scale-90 transition-transform" />
                    </div>
                  </div>
                </div>
              </section>

              {/* Account */}
              <section>
                <h3 className="text-sm font-medium text-gray-900 mb-3">{t('settings.account')}</h3>
                <div className="space-y-2">
                  <div className="flex items-center justify-between p-3 rounded-md hover:bg-gray-50 cursor-pointer transition-colors">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-green-50 rounded-md text-green-600">
                        <Shield size={18} />
                      </div>
                      <span className="text-sm text-gray-700">{t('settings.manageAccount')}</span>
                    </div>
                  </div>
                </div>
              </section>

              {/* About */}
              <section>
                <h3 className="text-sm font-medium text-gray-900 mb-3">{t('settings.about')}</h3>
                <div className="space-y-2">
                  <div className="flex items-center justify-between p-3 rounded-md hover:bg-gray-50 cursor-pointer transition-colors">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-orange-50 rounded-md text-orange-600">
                        <HelpCircle size={18} />
                      </div>
                      <span className="text-sm text-gray-700">{t('settings.helpFeedback')}</span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between p-3 rounded-md hover:bg-gray-50 cursor-pointer transition-colors">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-gray-50 rounded-md text-gray-600">
                        <Info size={18} />
                      </div>
                      <span className="text-sm text-gray-700">{t('settings.version')}</span>
                    </div>
                    <span className="text-xs text-gray-400">v1.0.0</span>
                  </div>
                </div>
              </section>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};
