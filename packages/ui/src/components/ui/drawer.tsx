import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils';
import { X } from 'lucide-react';

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  side?: 'left' | 'right' | 'bottom';
  width?: number | string;
  height?: number | string;
  showClose?: boolean;
  overlayClose?: boolean;
  className?: string;
}

const Drawer = ({
  open,
  onClose,
  children,
  side = 'right',
  width = 360,
  height = '100%',
  showClose = true,
  overlayClose = true,
  className,
}: DrawerProps) => {
  const isHorizontal = side === 'left' || side === 'right';

  const variants = {
    initial: {
      x: side === 'right' ? '100%' : side === 'left' ? '-100%' : 0,
      y: side === 'bottom' ? '100%' : 0,
    },
    animate: {
      x: 0,
      y: 0,
    },
    exit: {
      x: side === 'right' ? '100%' : side === 'left' ? '-100%' : 0,
      y: side === 'bottom' ? '100%' : 0,
    },
  };

  if (typeof document === 'undefined') return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="drawer-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={overlayClose ? onClose : undefined}
            className="fixed inset-0 bg-black/20 z-30"
          />
          <motion.div
            key="drawer-panel"
            initial={variants.initial}
            animate={variants.animate}
            exit={variants.exit}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            drag={isHorizontal ? 'x' : 'y'}
            dragConstraints={{ left: 0, right: 0, top: 0, bottom: 0 }}
            dragElastic={0}
            onDragEnd={(_e, info) => {
              const threshold = 50;
              if (side === 'right' && info.offset.x > threshold) onClose();
              else if (side === 'left' && info.offset.x < -threshold) onClose();
              else if (side === 'bottom' && info.offset.y > threshold) onClose();
            }}
            style={
              isHorizontal
                ? { width, height: '100%', top: 0, [side]: 0 }
                : { width: '100%', height, bottom: 0, left: 0 }
            }
            className={cn(
              'fixed bg-white shadow-xl z-40 flex flex-col',
              isHorizontal ? 'inset-y-0' : 'left-0 right-0',
              className,
            )}
          >
            {showClose && (
              <div className="flex justify-end p-2">
                <button
                  onClick={onClose}
                  className="p-1.5 hover:bg-gray-100 rounded transition-colors text-gray-500 hover:text-gray-700"
                >
                  <X size={20} />
                </button>
              </div>
            )}
            {children}
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
};

export { Drawer };
