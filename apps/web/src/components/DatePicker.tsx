import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@baicie/orbit-ui';

interface DatePickerProps {
  value: string | null;
  onChange: (date: string | null) => void;
  onClear?: () => void;
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const MONTHS = [
  '一月',
  '二月',
  '三月',
  '四月',
  '五月',
  '六月',
  '七月',
  '八月',
  '九月',
  '十月',
  '十一月',
  '十二月',
];

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

function formatDisplay(date: Date | null): string {
  if (!date) return '';
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function isToday(date: Date): boolean {
  return isSameDay(date, new Date());
}

function isPast(date: Date): boolean {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d < today;
}

export function DatePicker({ value, onChange, onClear }: DatePickerProps) {
  const today = new Date();
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());

  const selectedDate = value ? new Date(value + 'T00:00:00') : null;

  const firstDay = new Date(viewYear, viewMonth, 1);
  const lastDay = new Date(viewYear, viewMonth + 1, 0);
  const startPadding = firstDay.getDay();
  const totalDays = lastDay.getDate();

  const prevMonth = () => {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear((y) => y - 1);
    } else {
      setViewMonth((m) => m - 1);
    }
  };

  const nextMonth = () => {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear((y) => y + 1);
    } else {
      setViewMonth((m) => m + 1);
    }
  };

  const handleSelect = (day: number) => {
    const date = new Date(viewYear, viewMonth, day);
    onChange(formatDate(date));
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClear?.();
  };

  const cells: (number | null)[] = [
    ...Array(startPadding).fill(null),
    ...Array.from({ length: totalDays }, (_, i) => i + 1),
  ];

  const whilePadded = Math.ceil(cells.length / 7) * 7;
  while (cells.length < whilePadded) cells.push(null);

  return (
    <div className="w-[280px] bg-white rounded-xl shadow-xl border border-gray-200 overflow-hidden z-50">
      {/* Header: Month navigation */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 bg-gray-50/50">
        <Button variant="ghost" size="icon" onClick={prevMonth} className="p-1">
          <ChevronLeft size={16} />
        </Button>
        <span className="text-sm font-semibold text-gray-800">
          {viewYear} 年 {MONTHS[viewMonth]}
        </span>
        <Button variant="ghost" size="icon" onClick={nextMonth} className="p-1">
          <ChevronRight size={16} />
        </Button>
      </div>

      {/* Weekday header */}
      <div className="grid grid-cols-7 px-2 pt-2">
        {WEEKDAYS.map((d) => (
          <div key={d} className="text-center text-[10px] font-medium text-gray-400 py-1">
            {d}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="grid grid-cols-7 px-2 pb-2 gap-0.5">
        {cells.map((day, idx) => {
          if (day === null) {
            return <div key={`pad-${idx}`} className="h-8" />;
          }
          const date = new Date(viewYear, viewMonth, day);
          const isSelected = selectedDate && isSameDay(date, selectedDate);
          const isTodayDate = isToday(date);
          const isOverdue = isPast(date) && !isSelected;

          return (
            <Button
              key={day}
              variant="ghost"
              onClick={() => handleSelect(day)}
              className={`h-8 w-8 rounded-full text-xs flex items-center justify-center transition-colors ${
                isSelected
                  ? 'bg-blue-500 text-white font-semibold'
                  : isTodayDate
                    ? 'bg-blue-50 text-blue-600 font-semibold hover:bg-blue-100'
                    : isOverdue
                      ? 'text-gray-300 hover:bg-gray-50'
                      : 'text-gray-700 hover:bg-gray-100'
              }`}
            >
              {day}
            </Button>
          );
        })}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-3 py-2 border-t border-gray-100 bg-gray-50/50">
        <div className="text-xs text-gray-500">
          {selectedDate ? formatDisplay(selectedDate) : '未设置日期'}
        </div>
        <div className="flex gap-2">
          {value && (
            <Button
              variant="ghost"
              onClick={handleClear}
              className="text-xs text-gray-500 hover:text-red-500 px-2 py-1"
            >
              清除
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={() => {
              onChange(formatDate(new Date()));
            }}
            className="text-xs text-blue-500 hover:text-blue-600 px-2 py-1"
          >
            今天
          </Button>
        </div>
      </div>
    </div>
  );
}
