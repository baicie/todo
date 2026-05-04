import * as React from 'react';
import { motion } from 'framer-motion';
import { LayoutGrid, List } from 'lucide-react';

import { Button } from './button';
import { cn } from '../../lib/utils';

export interface ViewModeToggleProps {
  value: 'list' | 'table';
  onChange: (value: 'list' | 'table') => void;
  className?: string;
}

export const ViewModeToggle: React.FC<ViewModeToggleProps> = ({ value, onChange, className }) => {
  const options: Array<{ value: 'list' | 'table'; label: string; icon: React.ReactNode }> = [
    { value: 'list', label: '列表', icon: <List className="h-4 w-4" /> },
    { value: 'table', label: '网格', icon: <LayoutGrid className="h-4 w-4" /> },
  ];

  return (
    <div
      className={cn('relative inline-flex items-center gap-1 rounded-md bg-muted p-1', className)}
    >
      {options.map((option) => (
        <Button
          key={option.value}
          variant="ghost"
          size="sm"
          onClick={() => onChange(option.value)}
          className={cn(
            'relative z-10 h-7 gap-1.5 px-2 text-muted-foreground transition-colors hover:text-foreground',
            value === option.value && 'text-foreground',
          )}
        >
          {option.icon}
          <span className="text-xs font-medium">{option.label}</span>
          {value === option.value && (
            <motion.span
              layoutId="viewModeIndicator"
              className="absolute inset-0 -z-10 rounded-md bg-background shadow-sm"
              transition={{ type: 'spring', stiffness: 500, damping: 30 }}
            />
          )}
        </Button>
      ))}
    </div>
  );
};

ViewModeToggle.displayName = 'ViewModeToggle';
