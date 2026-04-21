import { useEffect, useRef } from 'react';

export interface KeyboardShortcut {
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  action: () => void;
  description?: string;
  /** 阻止默认浏览器行为 */
  preventDefault?: boolean;
  /** 是否在输入框聚焦时也生效 */
  allowInInput?: boolean;
}

type ModifierKey = 'ctrl' | 'meta' | 'shift' | 'alt';

const MODIFIER_KEYS: ModifierKey[] = ['ctrl', 'meta', 'shift', 'alt'];

function matchesShortcut(e: KeyboardEvent, shortcut: KeyboardShortcut): boolean {
  const key = shortcut.key.toLowerCase();
  const pressed = e.key.toLowerCase();

  if (pressed !== key) return false;

  const checks: boolean[] = [];

  for (const mod of MODIFIER_KEYS) {
    if (shortcut[mod]) {
      const pressed = e.getModifierState(
        mod === 'ctrl' ? 'Control' : mod === 'meta' ? 'Meta' : mod === 'shift' ? 'Shift' : 'Alt',
      );
      checks.push(pressed);
    }
  }

  return checks.every(Boolean);
}

function isInputElement(el: EventTarget | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}

export function useKeyboardShortcuts(shortcuts: KeyboardShortcut[]) {
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      for (const shortcut of shortcutsRef.current) {
        if (!matchesShortcut(e, shortcut)) continue;

        const target = e.target as HTMLElement;
        const inInput = isInputElement(target);

        if (inInput && !shortcut.allowInInput) continue;

        if (shortcut.preventDefault !== false) {
          e.preventDefault();
        }

        shortcut.action();
        return;
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
}

export function useGlobalShortcut(
  key: string,
  callback: () => void,
  options: {
    ctrl?: boolean;
    meta?: boolean;
    shift?: boolean;
    alt?: boolean;
    allowInInput?: boolean;
    preventDefault?: boolean;
  } = {},
) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== key.toLowerCase()) return;

      const opts = optionsRef.current;

      for (const mod of MODIFIER_KEYS) {
        if (
          opts[mod] &&
          !e.getModifierState(
            mod === 'ctrl'
              ? 'Control'
              : mod === 'meta'
                ? 'Meta'
                : mod === 'shift'
                  ? 'Shift'
                  : 'Alt',
          )
        ) {
          return;
        }
      }

      if (!opts.allowInInput && isInputElement(e.target)) return;

      if (opts.preventDefault !== false) e.preventDefault();
      callbackRef.current();
    }

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [key]);
}
