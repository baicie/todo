import * as React from 'react';

import { cn } from '../../lib/utils';

export interface TaskCheckboxProps {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const sizeMap = {
  sm: 16,
  md: 20,
  lg: 24,
};

export const TaskCheckbox = React.forwardRef<HTMLButtonElement, TaskCheckboxProps>(
  ({ checked = false, onChange, size = 'md', className }, ref) => {
    const dimension = sizeMap[size];

    const handleClick = () => {
      onChange?.(!checked);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        onChange?.(!checked);
      }
    };

    return (
      <button
        ref={ref}
        type="button"
        role="checkbox"
        aria-checked={checked}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        className={cn(
          'group relative inline-flex shrink-0 cursor-pointer items-center justify-center rounded-full border-2 transition-all duration-200',
          'hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          checked ? 'border-primary bg-primary' : 'border-muted-foreground/30 bg-transparent',
          className,
        )}
        style={{
          width: dimension,
          height: dimension,
        }}
      >
        <span
          className={cn(
            'flex items-center justify-center transition-all duration-200',
            checked ? 'scale-100 opacity-100' : 'scale-0 opacity-0',
          )}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-primary-foreground"
            style={{
              width: dimension * 0.6,
              height: dimension * 0.6,
            }}
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </span>
      </button>
    );
  },
);

TaskCheckbox.displayName = 'TaskCheckbox';
