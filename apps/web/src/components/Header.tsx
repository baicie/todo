import { Bell, Grid, HelpCircle, Search, Settings, User } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { SettingsDrawer } from './SettingsDrawer';

export const Header = () => {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

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
          <div className="relative group">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search
                size={16}
                className="text-blue-200 group-focus-within:text-[var(--theme-primary)]"
              />
            </div>
            <input
              type="text"
              className="block w-full pl-9 pr-3 py-1.5 border-none rounded bg-blue-600/50 text-white placeholder-blue-200 focus:outline-none focus:bg-white focus:text-gray-900 focus:placeholder-gray-500 transition-all text-sm h-8"
              placeholder={t('header.search')}
            />
          </div>
        </div>

        {/* Right: Actions & Profile */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => setIsSettingsOpen(true)}
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
          >
            <Bell size={20} strokeWidth={1.5} />
            <span className="absolute top-2 right-2 w-2 h-2 bg-red-500 rounded-full border border-[var(--theme-primary)]"></span>
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

      <SettingsDrawer isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
    </>
  );
};
