import { useCallback, useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { getStorage } from '@baicie/orbit-hooks';

export function OfflineIndicator() {
  const { t } = useTranslation();
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    const storage = getStorage();
    if (!storage) return;

    const updateCount = async () => {
      try {
        const db = (storage as { db?: { syncQueue?: { count?: () => Promise<number> } } }).db;
        if (db?.syncQueue?.count) {
          const count = await db.syncQueue.count();
          setPendingCount(count);
        }
      } catch {
        // IndexedDB may not have syncQueue yet
      }
    };

    updateCount();
    const interval = setInterval(updateCount, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleRetry = useCallback(async () => {
    if (!navigator.onLine) return;
    try {
      const registration = await navigator.serviceWorker?.ready;
      if (registration && 'sync' in registration) {
        await (
          registration as ServiceWorkerRegistration & {
            sync: { register: (tag: string) => Promise<void> };
          }
        ).sync.register('sync-tasks');
      }
    } catch {
      // Background sync may not be available
    }
  }, []);

  return (
    <AnimatePresence>
      {!isOnline && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="overflow-hidden"
        >
          <div
            className="flex items-center justify-center gap-2 px-4 py-2 bg-amber-50 border-b border-amber-200 text-amber-800 text-sm"
            role="status"
            aria-live="polite"
          >
            <WifiOff size={16} className="flex-shrink-0" />
            <span>{t('pwa.offline')}</span>
            {pendingCount > 0 && (
              <span className="text-xs bg-amber-200 px-1.5 py-0.5 rounded">
                {t('pwa.pendingSync', { count: pendingCount })}
              </span>
            )}
            <button
              onClick={handleRetry}
              className="ml-2 text-xs font-medium text-amber-900 underline hover:no-underline"
            >
              {t('pwa.retry')}
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
