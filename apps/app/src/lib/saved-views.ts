import type { SavedView } from '../types';

const SAVED_VIEWS_KEY = 'shishi.saved-views.v1';

export function loadSavedViews(): SavedView[] {
  try {
    const raw = localStorage.getItem(SAVED_VIEWS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is SavedView =>
        Boolean(item) &&
        typeof item === 'object' &&
        typeof (item as SavedView).id === 'string' &&
        typeof (item as SavedView).name === 'string' &&
        Boolean((item as SavedView).view) &&
        Boolean((item as SavedView).filter),
    );
  } catch {
    return [];
  }
}

export function persistSavedViews(views: SavedView[]): void {
  try {
    localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(views));
  } catch {
    // Private browsing can reject storage; the in-memory list still works.
  }
}
