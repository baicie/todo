import { useCallback, useEffect, useState } from 'react';
import type { SyncQueueListener } from '@baicie/orbit';
import { syncQueue } from '@baicie/orbit';

export interface SyncState {
  pendingCount: number;
  isSyncing: boolean;
  isOnline: boolean;
  lastSyncAt: Date | null;
  syncError: string | null;
}

export interface SyncActions {
  triggerSync: () => void;
  retryFailed: () => void;
  clearQueue: () => Promise<void>;
}

export function useSync(): SyncState & SyncActions {
  const [state, setState] = useState<SyncState>({
    pendingCount: 0,
    isSyncing: false,
    isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
    lastSyncAt: null,
    syncError: null,
  });

  useEffect(() => {
    const listener: SyncQueueListener = {
      onQueueChange: (pending) => {
        setState((prev) => ({ ...prev, pendingCount: pending }));
      },
      onSyncStart: () => {
        setState((prev) => ({ ...prev, isSyncing: true, syncError: null }));
      },
      onSyncComplete: (_success, failed) => {
        setState((prev) => ({
          ...prev,
          isSyncing: false,
          lastSyncAt: new Date(),
          syncError: failed > 0 ? `${failed} 项同步失败` : null,
        }));
      },
      onOnlineStatusChange: (online) => {
        setState((prev) => ({ ...prev, isOnline: online }));
      },
    };

    const unsubscribe = syncQueue.addListener(listener);
    syncQueue.getQueueSize().then((size) => {
      setState((prev) => ({ ...prev, pendingCount: size }));
    });

    return unsubscribe;
  }, []);

  const triggerSync = useCallback(() => {
    syncQueue.processQueue();
  }, []);

  const retryFailed = useCallback(() => {
    syncQueue.retryFailed();
  }, []);

  const clearQueue = useCallback(async () => {
    await syncQueue.clearQueue();
  }, []);

  return {
    ...state,
    triggerSync,
    retryFailed,
    clearQueue,
  };
}
