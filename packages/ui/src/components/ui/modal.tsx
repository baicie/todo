import * as React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils';
import { X } from 'lucide-react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: React.ReactNode;
  description?: React.ReactNode;
  showClose?: boolean;
  overlayClose?: boolean;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  footer?: React.ReactNode;
}

const sizeClasses: Record<NonNullable<ModalProps['size']>, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
};

const Modal = ({
  open,
  onClose,
  children,
  title,
  description,
  showClose = true,
  overlayClose = true,
  size = 'md',
  className,
  footer,
}: ModalProps) => {
  React.useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="modal-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={overlayClose ? onClose : undefined}
            className="fixed inset-0 bg-black/30 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          />
          <motion.div
            key="modal-panel"
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ type: 'spring', stiffness: 300, damping: 25 }}
            className={cn(
              'fixed z-50 bg-white rounded-xl shadow-2xl w-full',
              sizeClasses[size],
              className,
            )}
            style={{ maxHeight: '90vh' }}
          >
            {(title || showClose) && (
              <div className="flex items-start justify-between p-5 pb-0">
                <div>
                  {title && <h2 className="text-lg font-semibold text-gray-900">{title}</h2>}
                  {description && <p className="text-sm text-gray-500 mt-0.5">{description}</p>}
                </div>
                {showClose && (
                  <button
                    onClick={onClose}
                    className="p-1 hover:bg-gray-100 rounded transition-colors text-gray-500 hover:text-gray-700 ml-4 flex-shrink-0"
                  >
                    <X size={18} />
                  </button>
                )}
              </div>
            )}
            <div
              className="p-5 overflow-y-auto"
              style={{ maxHeight: footer ? 'calc(90vh - 120px)' : '90vh' }}
            >
              {children}
            </div>
            {footer && (
              <div className="px-5 py-4 border-t border-gray-100 flex justify-end gap-2">
                {footer}
              </div>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
};

export { Modal };
