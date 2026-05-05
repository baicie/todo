import * as React from 'react';

import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '../../lib/utils';

type TaskDetailDropdownMenuContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
};

const TaskDetailDropdownMenuContext =
  React.createContext<TaskDetailDropdownMenuContextValue | null>(null);

function useDropdownContext() {
  const context = React.useContext(TaskDetailDropdownMenuContext);
  if (!context) {
    throw new Error(
      'TaskDetailDropdownMenu components must be used within a TaskDetailDropdownMenu',
    );
  }
  return context;
}

interface TaskDetailDropdownMenuProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

const TaskDetailDropdownMenu = React.forwardRef<HTMLDivElement, TaskDetailDropdownMenuProps>(
  ({ className, children, ...props }, ref) => {
    const [open, setOpen] = React.useState(false);

    return (
      <TaskDetailDropdownMenuContext.Provider value={{ open, setOpen }}>
        <div ref={ref} className={cn('relative', className)} {...props}>
          {children}
        </div>
      </TaskDetailDropdownMenuContext.Provider>
    );
  },
);
TaskDetailDropdownMenu.displayName = 'TaskDetailDropdownMenu';

interface TaskDetailDropdownMenuTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
}

const TaskDetailDropdownMenuTrigger = React.forwardRef<
  HTMLButtonElement,
  TaskDetailDropdownMenuTriggerProps
>(({ className, children, ...props }, ref) => {
  const { open, setOpen } = useDropdownContext();

  return (
    <button ref={ref} type="button" className={className} onClick={() => setOpen(!open)} {...props}>
      {children}
    </button>
  );
});
TaskDetailDropdownMenuTrigger.displayName = 'TaskDetailDropdownMenuTrigger';

interface TaskDetailDropdownMenuContentProps extends React.HTMLAttributes<HTMLDivElement> {
  align?: 'left' | 'right';
}

const TaskDetailDropdownMenuContent = React.forwardRef<
  HTMLDivElement,
  TaskDetailDropdownMenuContentProps
>(
  (
    {
      className,
      align = 'left',
      children,
      // 排除与 framer-motion 冲突的 HTML 属性
      onAnimationStart,
      onAnimationEnd,
      onAnimationIteration,
      onDrag,
      onDragStart,
      onDragEnd,
      onDragOver,
      onDragEnter,
      onDragLeave,
      onDragExit,
      onDrop,
      onTransitionEnd,
      onTransitionStart,
      ...props
    },
    ref,
  ) => {
    const { open, setOpen } = useDropdownContext();

    return (
      <AnimatePresence>
        {open && (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} aria-hidden="true" />
            <motion.div
              ref={ref}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              transition={{ duration: 0.15 }}
              className={cn(
                'absolute left-0 right-0 top-full z-30 bg-white rounded-md shadow-lg border border-gray-100 py-1',
                align === 'right' ? 'left-auto right-0' : 'left-0 right-auto',
                className,
              )}
              {...props}
            >
              {children}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    );
  },
);
TaskDetailDropdownMenuContent.displayName = 'TaskDetailDropdownMenuContent';

interface TaskDetailDropdownMenuItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: React.ReactNode;
  danger?: boolean;
  selected?: boolean;
  children: React.ReactNode;
}

const TaskDetailDropdownMenuItem = React.forwardRef<
  HTMLButtonElement,
  TaskDetailDropdownMenuItemProps
>(({ className, icon, danger, selected, children, ...props }, ref) => {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        'w-full text-left px-4 py-2 text-sm hover:bg-gray-50 transition-colors flex items-center justify-between gap-2',
        danger ? 'text-red-500 hover:bg-red-50' : 'text-gray-700',
        selected && 'text-[var(--theme-primary)] bg-blue-50',
        className,
      )}
      {...props}
    >
      <div className="flex items-center gap-2 flex-1">
        {icon && <span className="text-gray-400 flex-shrink-0">{icon}</span>}
        <span>{children}</span>
      </div>
      {selected && (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="flex-shrink-0"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
    </button>
  );
});
TaskDetailDropdownMenuItem.displayName = 'TaskDetailDropdownMenuItem';

interface TaskDetailDropdownMenuLabelProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

const TaskDetailDropdownMenuLabel = React.forwardRef<
  HTMLDivElement,
  TaskDetailDropdownMenuLabelProps
>(({ className, children, ...props }, ref) => {
  return (
    <div
      ref={ref}
      className={cn(
        'px-4 py-2 text-sm font-medium text-gray-900 border-b border-gray-100',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
});
TaskDetailDropdownMenuLabel.displayName = 'TaskDetailDropdownMenuLabel';

const TaskDetailDropdownMenuSeparator = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => {
  return <div ref={ref} className={cn('border-t border-gray-100 my-1', className)} {...props} />;
});
TaskDetailDropdownMenuSeparator.displayName = 'TaskDetailDropdownMenuSeparator';

export {
  TaskDetailDropdownMenu,
  TaskDetailDropdownMenuTrigger,
  TaskDetailDropdownMenuContent,
  TaskDetailDropdownMenuItem,
  TaskDetailDropdownMenuLabel,
  TaskDetailDropdownMenuSeparator,
};

export type {
  TaskDetailDropdownMenuProps,
  TaskDetailDropdownMenuTriggerProps,
  TaskDetailDropdownMenuContentProps,
  TaskDetailDropdownMenuItemProps,
  TaskDetailDropdownMenuLabelProps,
};
