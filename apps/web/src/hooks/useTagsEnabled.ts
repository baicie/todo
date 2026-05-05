import { useEffect, useState } from 'react';

const TAGS_ENABLED_KEY = 'orbit_tags_enabled';

export function useTagsEnabled() {
  const [enabled, setEnabled] = useState(() => localStorage.getItem(TAGS_ENABLED_KEY) === 'true');

  useEffect(() => {
    const handler = () => {
      setEnabled(localStorage.getItem(TAGS_ENABLED_KEY) === 'true');
    };
    window.addEventListener('tags-enabled-changed', handler);
    window.addEventListener('storage', handler);
    return () => {
      window.removeEventListener('tags-enabled-changed', handler);
      window.removeEventListener('storage', handler);
    };
  }, []);

  return enabled;
}

export function setTagsEnabled(enabled: boolean) {
  localStorage.setItem(TAGS_ENABLED_KEY, enabled ? 'true' : 'false');
  window.dispatchEvent(new Event('tags-enabled-changed'));
}
