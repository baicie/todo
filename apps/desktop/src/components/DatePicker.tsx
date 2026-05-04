import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useState } from 'react';

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
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 bg-gray-50/50">
        <button
          onClick={prevMonth}
          className="p-1 hover:bg-gray-100 rounded transition-colors text-gray-500"
        >
          <ChevronLeft size={16} />
        </button>
        <span className="text-sm font-semibold text-gray-800">
          {viewYear} 年 {MONTHS[viewMonth]}
        </span>
        <button
          onClick={nextMonth}
          className="p-1 hover:bg-gray-100 rounded transition-colors text-gray-500"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      <div className="grid grid-cols-7 px-2 pt-2">
        {WEEKDAYS.map((d) => (
          <div key={d} className="text-center text-[10px] font-medium text-gray-400 py-1">
            {d}
          </div>
        ))}
      </div>

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
            <button
              key={day}
              onClick={() => onChange(formatDate(date))}
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
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-between px-3 py-2 border-t border-gray-100 bg-gray-50/50">
        <div className="text-xs text-gray-500">
          {selectedDate ? formatDisplay(selectedDate) : '未设置日期'}
        </div>
        <div className="flex gap-2">
          {value && (
            <button
              onClick={handleClear}
              className="text-xs text-gray-500 hover:text-red-500 transition-colors px-2 py-1 rounded hover:bg-red-50"
            >
              清除
            </button>
          )}
          <button
            onClick={() => onChange(formatDate(new Date()))}
            className="text-xs text-blue-500 hover:text-blue-600 transition-colors px-2 py-1 rounded hover:bg-blue-50"
          >
            今天
          </button>
        </div>
      </div>
    </div>
  );
}
