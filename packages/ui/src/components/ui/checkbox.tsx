import * as React from 'react';
import { cn } from '../../lib/utils';

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: React.ReactNode;
  description?: React.ReactNode;
  indeterminate?: boolean;
}

const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, label, description, indeterminate, ...props }, ref) => {
    const innerRef = React.useRef<HTMLInputElement>(null);

    React.useImperativeHandle(ref, () => innerRef.current!);

    React.useEffect(() => {
      if (innerRef.current) {
        innerRef.current.indeterminate = indeterminate ?? false;
      }
    }, [indeterminate]);

    return (
      <label className={cn('flex items-start gap-3 cursor-pointer select-none group', className)}>
        <div className="relative flex-shrink-0 mt-0.5">
          <input type="checkbox" ref={innerRef} className="peer sr-only" {...props} />
          <div
            className={cn(
              'w-5 h-5 rounded border-2 transition-all flex items-center justify-center',
              'peer-checked:bg-[var(--theme-primary)] peer-checked:border-[var(--theme-primary)]',
              'peer-indeterminate:bg-[var(--theme-primary)] peer-indeterminate:border-[var(--theme-primary)]',
              'border-gray-300 hover:border-[var(--theme-primary)]',
              'peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--theme-primary)] peer-focus-visible:ring-offset-1',
              'peer-disabled:opacity-50 peer-disabled:cursor-not-allowed',
            )}
          >
            {props.checked && !indeterminate && (
              <svg
                className="w-3 h-3 text-white"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3.5"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
            {indeterminate && <div className="w-2.5 h-0.5 bg-white rounded" />}
          </div>
        </div>
        {(label || description) && (
          <div className="flex flex-col">
            {label && (
              <span
                className={cn(
                  'text-sm font-medium transition-colors',
                  props.checked
                    ? 'text-gray-400 line-through'
                    : 'text-gray-900 group-hover:text-gray-700',
                )}
              >
                {label}
              </span>
            )}
            {description && <span className="text-xs text-gray-500 mt-0.5">{description}</span>}
          </div>
        )}
      </label>
    );
  },
);
Checkbox.displayName = 'Checkbox';

export { Checkbox };
