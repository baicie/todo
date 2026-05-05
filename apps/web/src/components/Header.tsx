import { Bell, Grid, HelpCircle, LogOut, Search, Settings } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Avatar, Button, Dropdown, DropdownItem } from '@baicie/orbit-ui';
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
          <Button
            onClick={() => setIsSearchOpen(true)}
            variant="secondary"
            className="relative group w-full flex items-center gap-2 pl-3 pr-3 py-1.5 h-8 text-left justify-start"
          >
            <Search size={16} />
            <span className="flex-1">{t('header.search')}</span>
            <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 text-xs text-blue-200/70 bg-blue-500/30 rounded border border-blue-400/30">
              Ctrl+K
            </kbd>
          </Button>
        </div>

        {/* Right: Actions & Profile */}
        <div className="flex items-center gap-1">
          <Button
            onClick={() => navigate('/settings')}
            variant="ghost"
            className="p-2"
            title={t('header.settings')}
          >
            <Settings size={20} strokeWidth={1.5} />
          </Button>
          <Button variant="ghost" className="p-2" title={t('header.help')}>
            <HelpCircle size={20} strokeWidth={1.5} />
          </Button>
          <Button
            variant="ghost"
            className="p-2 relative"
            title={t('header.notifications')}
            onClick={() => setIsNotificationOpen(true)}
          >
            <Bell size={20} strokeWidth={1.5} />
            {unreadCount > 0 && (
              <span className="absolute top-1.5 right-1.5 min-w-[16px] h-4 px-1 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center leading-none">
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </Button>

          <Dropdown
            trigger={
              <Avatar
                name={user?.name}
                size="sm"
                className="cursor-pointer ring-2 ring-white/30 hover:ring-white/50 transition-all"
              />
            }
            triggerMode="hover"
            closeDelay={200}
          >
            <div className="px-3 py-2 border-b border-gray-100">
              <p className="text-sm font-medium text-gray-900">{user?.name}</p>
              <p className="text-xs text-gray-500 truncate">{user?.email}</p>
            </div>
            <DropdownItem icon={<LogOut size={14} />} danger onClick={logout}>
              {t('header.logout')}
            </DropdownItem>
          </Dropdown>
        </div>
      </header>

      <NotificationPanel isOpen={isNotificationOpen} onClose={() => setIsNotificationOpen(false)} />
      <SearchPanel isOpen={isSearchOpen} onClose={() => setIsSearchOpen(false)} />
    </>
  );
};
