import * as React from 'react';
import { cn } from '../../lib/utils';
import { Calendar as CalendarIcon } from 'lucide-react';

interface DatePickerProps {
  value?: string | null;
  onChange: (date: string | null) => void;
  placeholder?: string;
  minDate?: Date;
  maxDate?: Date;
  className?: string;
  type?: 'date' | 'datetime-local';
}

const DatePicker = React.forwardRef<HTMLInputElement, DatePickerProps>(
  (
    { value, onChange, placeholder = '选择日期', type = 'date', className, minDate, maxDate },
    ref,
  ) => {
    const inputId = React.useId();

    const formatValue = (isoDate: string | null | undefined): string => {
      if (!isoDate) return '';
      const d = new Date(isoDate);
      if (type === 'datetime-local') {
        const pad = (n: number) => n.toString().padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      }
      const pad = (n: number) => n.toString().padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };

    return (
      <div className={cn('relative inline-flex items-center', className)}>
        <label htmlFor={inputId} className="sr-only">
          {placeholder}
        </label>
        <CalendarIcon size={16} className="absolute left-3 text-gray-400 pointer-events-none" />
        <input
          id={inputId}
          ref={ref}
          type={type}
          value={formatValue(value)}
          onChange={(e) => {
            const val = e.target.value;
            onChange(val ? new Date(val).toISOString() : null);
          }}
          min={minDate ? formatValue(minDate.toISOString()) : undefined}
          max={maxDate ? formatValue(maxDate.toISOString()) : undefined}
          className={cn(
            'flex h-9 w-full rounded-md border border-input bg-transparent pl-9 pr-3 py-1 text-sm shadow-sm',
            'file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground',
            'placeholder:text-muted-foreground',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
        />
      </div>
    );
  },
);
DatePicker.displayName = 'DatePicker';

export { DatePicker };
