import * as React from 'react';
import { cn } from '../../lib/utils';
import { getInitials } from '@baicie/orbit-utils';

export interface AvatarProps {
  src?: string | null;
  alt?: string;
  name?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}

const sizeClasses = {
  xs: 'w-6 h-6 text-xs',
  sm: 'w-8 h-8 text-sm',
  md: 'w-10 h-10 text-base',
  lg: 'w-12 h-12 text-lg',
  xl: 'w-16 h-16 text-xl',
};

const Avatar = React.forwardRef<HTMLDivElement, AvatarProps>(
  ({ src, alt, name, size = 'md', className }, ref) => {
    const [imageError, setImageError] = React.useState(false);

    const initials = name ? getInitials(name) : '?';

    return (
      <div
        ref={ref}
        className={cn(
          'relative inline-flex items-center justify-center rounded-full bg-blue-100 text-blue-600 font-semibold overflow-hidden flex-shrink-0',
          sizeClasses[size],
          className,
        )}
      >
        {src && !imageError ? (
          <img
            src={src}
            alt={alt ?? name ?? 'avatar'}
            className="w-full h-full object-cover"
            onError={() => setImageError(true)}
          />
        ) : (
          <span>{initials}</span>
        )}
      </div>
    );
  },
);
Avatar.displayName = 'Avatar';

export { Avatar };
