import { Check, Star, Sun, Trash2, X } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { Button } from '@baicie/orbit-ui';

interface BatchActionsBarProps {
  selectedCount: number;
  onClear: () => void;
  onMarkComplete: () => void;
  onMarkImportant: () => void;
  onAddToMyDay: () => void;
  onDelete: () => void;
}

export function BatchActionsBar({
  selectedCount,
  onClear,
  onMarkComplete,
  onMarkImportant,
  onAddToMyDay,
  onDelete,
}: BatchActionsBarProps) {
  return (
    <AnimatePresence>
      {selectedCount > 0 && (
        <motion.div
          initial={{ y: -60, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -60, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 400, damping: 30 }}
          className="fixed top-0 left-0 right-0 z-40 bg-white border-b border-gray-200 shadow-sm"
        >
          <div className="flex items-center justify-between px-4 py-3">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="icon" onClick={onClear} title="清除选择">
                <X size={18} className="text-gray-500" />
              </Button>
              <span className="text-sm font-medium text-gray-700">{selectedCount} 已选择</span>
            </div>

            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" onClick={onMarkComplete} title="标记完成">
                <Check size={16} />
                <span className="hidden sm:inline">完成</span>
              </Button>

              <Button variant="ghost" size="sm" onClick={onMarkImportant} title="标记重要">
                <Star size={16} />
                <span className="hidden sm:inline">重要</span>
              </Button>

              <Button variant="ghost" size="sm" onClick={onAddToMyDay} title="添加到我的一天">
                <Sun size={16} />
                <span className="hidden sm:inline">我的一天</span>
              </Button>

              <div className="w-px h-5 bg-gray-200 mx-1" />

              <Button
                variant="ghost"
                size="sm"
                onClick={onDelete}
                title="删除"
                className="text-red-600 hover:bg-red-50"
              >
                <Trash2 size={16} />
                <span className="hidden sm:inline">删除</span>
              </Button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
