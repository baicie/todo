import { useEffect } from 'react';

const EVENTS = {
  OPEN_COMMAND_PALETTE: 'open-command-palette',
  OPEN_SETTINGS: 'open-settings',
  OPEN_SEARCH: 'open-search',
} as const;

type AppEventName = (typeof EVENTS)[keyof typeof EVENTS];

export function dispatchAppEvent(name: AppEventName) {
  window.dispatchEvent(new CustomEvent(name));
}

export function useAppEvent(name: AppEventName, handler: () => void) {
  useEffect(() => {
    const listener = () => handler();
    window.addEventListener(name, listener);
    return () => window.removeEventListener(name, listener);
  }, [name, handler]);
}

export { EVENTS };
