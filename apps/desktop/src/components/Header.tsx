import { useTranslation } from 'react-i18next';
import { Settings } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export function Header() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();

  return (
    <header className="h-12 px-4 flex items-center justify-between border-b border-gray-200 bg-white">
      <div className="flex items-center gap-2">
        <span className="text-sm font-bold text-[var(--theme-primary)]">Orbit</span>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => navigate('/settings')}
          className="p-2 hover:bg-gray-100 rounded transition-colors"
          title="设置"
        >
          <Settings size={18} className="text-gray-600" />
        </button>
        {user?.name && (
          <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center text-white text-sm font-medium">
            {user.name.charAt(0).toUpperCase()}
          </div>
        )}
      </div>
    </header>
  );
}
