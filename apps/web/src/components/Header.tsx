import { Bell, Grid, HelpCircle, Search, Settings, User } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { NotificationPanel } from './NotificationPanel';
import { SearchPanel } from './SearchPanel';
import { useNotifications } from '@baicie/orbit-hooks';

export const Header = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { unreadCount } = useNotifications();
  const [isNotificationOpen, setIsNotificationOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);

  return (
    <>
      <header className="h-12 bg-[var(--theme-primary)] text-white flex items-center justify-between px-3 z-50 relative shadow-sm">
        {/* Left: Logo */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 font-semibold text-lg cursor-pointer">
            <Grid size={20} />
            <span>{t('app.title')}</span>
          </div>
        </div>

        {/* Center: Search */}
        <div className="flex-1 max-w-xl mx-4">
          <button
            onClick={() => setIsSearchOpen(true)}
            className="relative group w-full flex items-center gap-2 pl-3 pr-3 py-1.5 border-none rounded bg-blue-600/50 text-blue-200 hover:bg-blue-600/60 transition-all text-sm h-8 text-left"
          >
            <Search size={16} />
            <span className="flex-1">{t('header.search')}</span>
            <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 text-xs text-blue-200/70 bg-blue-500/30 rounded border border-blue-400/30">
              Ctrl+K
            </kbd>
          </button>
        </div>

        {/* Right: Actions & Profile */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => navigate('/settings')}
            className="p-2 hover:bg-black/10 rounded transition-colors"
            title={t('header.settings')}
          >
            <Settings size={20} strokeWidth={1.5} />
          </button>
          <button
            className="p-2 hover:bg-black/10 rounded transition-colors"
            title={t('header.help')}
          >
            <HelpCircle size={20} strokeWidth={1.5} />
          </button>
          <button
            className="p-2 hover:bg-black/10 rounded transition-colors relative"
            title={t('header.notifications')}
            onClick={() => setIsNotificationOpen(true)}
          >
            <Bell size={20} strokeWidth={1.5} />
            {unreadCount > 0 && (
              <span className="absolute top-1.5 right-1.5 min-w-[16px] h-4 px-1 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center leading-none">
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </button>

          <div className="ml-2 relative group cursor-pointer">
            <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center text-sm font-medium hover:bg-white/30 transition-colors border border-white/30">
              {user?.name?.[0]?.toUpperCase() || <User size={16} />}
            </div>

            {/* Dropdown Menu */}
            <div className="absolute right-0 top-full mt-1 w-48 bg-white rounded-md shadow-lg py-1 hidden group-hover:block border border-gray-200">
              <div className="px-4 py-2 border-b border-gray-100">
                <p className="text-sm font-medium text-gray-900">{user?.name}</p>
                <p className="text-xs text-gray-500 truncate">{user?.email}</p>
              </div>
              <button
                onClick={logout}
                className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-gray-50 transition-colors"
              >
                {t('header.logout')}
              </button>
            </div>
          </div>
        </div>
      </header>

      <NotificationPanel isOpen={isNotificationOpen} onClose={() => setIsNotificationOpen(false)} />
      <SearchPanel isOpen={isSearchOpen} onClose={() => setIsSearchOpen(false)} />
    </>
  );
};
