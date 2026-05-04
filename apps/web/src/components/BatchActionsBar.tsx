import { Check, Star, Sun, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();

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
              <Button
                variant="ghost"
                size="icon"
                onClick={onClear}
                title={t('batch.clearSelection')}
              >
                <X size={18} className="text-gray-500" />
              </Button>
              <span className="text-sm font-medium text-gray-700">
                {selectedCount} {t('batch.selected')}
              </span>
            </div>

            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                onClick={onMarkComplete}
                title={t('batch.markComplete')}
                className="gap-1.5 px-3 py-1.5 text-sm text-gray-600"
              >
                <Check size={16} />
                <span className="hidden sm:inline">{t('batch.complete')}</span>
              </Button>

              <Button
                variant="ghost"
                onClick={onMarkImportant}
                title={t('batch.markImportant')}
                className="gap-1.5 px-3 py-1.5 text-sm text-gray-600"
              >
                <Star size={16} />
                <span className="hidden sm:inline">{t('batch.important')}</span>
              </Button>

              <Button
                variant="ghost"
                onClick={onAddToMyDay}
                title={t('batch.addToMyDay')}
                className="gap-1.5 px-3 py-1.5 text-sm text-gray-600"
              >
                <Sun size={16} />
                <span className="hidden sm:inline">{t('batch.myDay')}</span>
              </Button>

              <div className="w-px h-5 bg-gray-200 mx-1" />

              <Button
                variant="ghost"
                onClick={onDelete}
                title={t('batch.delete')}
                className="gap-1.5 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50"
              >
                <Trash2 size={16} />
                <span className="hidden sm:inline">{t('batch.delete')}</span>
              </Button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
