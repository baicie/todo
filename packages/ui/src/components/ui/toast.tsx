import * as React from 'react';
import { cn } from '../../lib/utils';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, CheckCircle, Info, X, XCircle } from 'lucide-react';

export interface ToastProps {
  id: string;
  title?: string;
  description?: string;
  variant?: 'default' | 'success' | 'error' | 'warning' | 'info';
  duration?: number;
}

const variantConfig = {
  default: {
    icon: null,
    className: 'bg-gray-900 text-white',
  },
  success: {
    icon: CheckCircle,
    className: 'bg-green-600 text-white',
  },
  error: {
    icon: XCircle,
    className: 'bg-red-600 text-white',
  },
  warning: {
    icon: AlertCircle,
    className: 'bg-amber-500 text-white',
  },
  info: {
    icon: Info,
    className: 'bg-blue-600 text-white',
  },
};

function Toast({ id, title, description, variant = 'default', duration = 4000 }: ToastProps) {
  const config = variantConfig[variant];
  const Icon = config.icon;

  React.useEffect(() => {
    if (duration > 0) {
      const timer = setTimeout(() => {
        toastStore.delete(id);
      }, duration);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [id, duration]);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -20, scale: 0.95 }}
      transition={{ duration: 0.2 }}
      className={cn(
        'pointer-events-auto flex w-full max-w-sm items-start gap-3 overflow-hidden rounded-lg border p-4 shadow-lg',
        config.className,
      )}
    >
      {Icon && <Icon size={20} className="flex-shrink-0 mt-0.5" />}
      <div className="flex-1">
        {title && <p className="text-sm font-semibold">{title}</p>}
        {description && (
          <p className={cn('mt-1 text-sm opacity-90', title ? 'opacity-80' : '')}>{description}</p>
        )}
      </div>
      <button
        onClick={() => toastStore.delete(id)}
        className="flex-shrink-0 rounded-md p-1 opacity-70 hover:opacity-100 transition-opacity"
      >
        <X size={14} />
      </button>
    </motion.div>
  );
}

// Toast store
type ToastItem = Omit<ToastProps, 'id'> & { id: string };

class ToastStore {
  private listeners: Set<(toasts: ToastItem[]) => void> = new Set();
  private toasts: ToastItem[] = [];

  subscribe(listener: (toasts: ToastItem[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify() {
    this.listeners.forEach((l) => l([...this.toasts]));
  }

  add(toast: Omit<ToastProps, 'id'>) {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.toasts = [...this.toasts, { ...toast, id }];
    this.notify();
    return id;
  }

  delete(id: string) {
    this.toasts = this.toasts.filter((t) => t.id !== id);
    this.notify();
  }

  success(title: string, description?: string) {
    return this.add({ title, description, variant: 'success' });
  }

  error(title: string, description?: string) {
    return this.add({ title, description, variant: 'error' });
  }

  warning(title: string, description?: string) {
    return this.add({ title, description, variant: 'warning' });
  }

  info(title: string, description?: string) {
    return this.add({ title, description, variant: 'info' });
  }
}

export const toastStore = new ToastStore();

export function Toaster() {
  const [toasts, setToasts] = React.useState<ToastItem[]>([]);

  React.useEffect(() => {
    const unsubscribe = toastStore.subscribe(setToasts);
    return () => unsubscribe();
  }, []);

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
      <AnimatePresence mode="popLayout">
        {toasts.map((toast) => (
          <Toast key={toast.id} {...toast} />
        ))}
      </AnimatePresence>
    </div>
  );
}

export const toast = {
  show: (props: Omit<ToastProps, 'id'>) => toastStore.add(props),
  success: (title: string, description?: string) => toastStore.success(title, description),
  error: (title: string, description?: string) => toastStore.error(title, description),
  warning: (title: string, description?: string) => toastStore.warning(title, description),
  info: (title: string, description?: string) => toastStore.info(title, description),
  dismiss: (id: string) => toastStore.delete(id),
};
