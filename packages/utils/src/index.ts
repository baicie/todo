// Object utilities
export { extend } from './object';

// Date utilities
export {
  formatDate,
  formatDateTime,
  formatRelativeTime,
  isOverdue,
  isDueToday,
  isDueTomorrow,
  isDueThisWeek,
  isDuePast,
  parseISODate,
  startOfDay,
  endOfDay,
  addDays,
  getWeekdayName,
  getDayOfWeek,
  getDueDateText,
} from './date';

// String utilities
export {
  truncate,
  capitalize,
  capitalizeWords,
  slugify,
  camelToKebab,
  kebabToCamel,
  snakeToCamel,
  camelToSnake,
  escapeHtml,
  unescapeHtml,
  stripHtml,
  stripHtmlAndTrim,
  isValidEmail,
  isValidUrl,
  generateId,
  padNumber,
  getInitials,
  removeAccents,
  fuzzyMatch,
} from './string';

// Function utilities
export { debounce, throttle, memoize, sleep, retry } from './function';

// Array utilities
export {
  groupBy,
  uniq,
  uniqBy,
  sortBy,
  sortByDesc,
  chunk,
  flatten,
  difference,
  intersection,
  union,
  pluck,
  compact,
  take,
  drop,
  sum,
  average,
  min,
  max,
} from './array';

// Filter utilities
export { SMART_LISTS, buildFilter, getListTitle } from './filter';
export type { SmartListId, GetListTitleOptions } from './filter';
