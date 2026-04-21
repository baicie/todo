/**
 * Array utility functions.
 */

export function groupBy<T, K extends string | number>(
  array: T[],
  keyFn: (item: T) => K,
): Record<K, T[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = {};
  for (const item of array) {
    const key = keyFn(item);
    if (!result[key]) {
      result[key] = [];
    }
    result[key].push(item);
  }
  return result as Record<K, T[]>;
}

export function uniq<T>(array: T[]): T[] {
  return Array.from(new Set(array));
}

export function uniqBy<T, K>(array: T[], keyFn: (item: T) => K): T[] {
  const seen = new Set<K>();
  const result: T[] = [];
  for (const item of array) {
    const key = keyFn(item);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

export function sortBy<T>(array: T[], keyFn: (item: T) => string | number): T[] {
  return [...array].sort((a, b) => {
    const keyA = keyFn(a);
    const keyB = keyFn(b);
    if (keyA < keyB) return -1;
    if (keyA > keyB) return 1;
    return 0;
  });
}

export function sortByDesc<T>(array: T[], keyFn: (item: T) => string | number): T[] {
  return sortBy(array, keyFn).reverse();
}

export function chunk<T>(array: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}

export function flatten<T>(array: (T | T[])[]): T[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return array.reduce<T[]>((acc, val) => acc.concat(Array.isArray(val) ? val : (val as any)), []);
}

export function difference<T>(arr1: T[], arr2: T[]): T[] {
  const set2 = new Set(arr2);
  return arr1.filter((item) => !set2.has(item));
}

export function intersection<T>(arr1: T[], arr2: T[]): T[] {
  const set2 = new Set(arr2);
  return arr1.filter((item) => set2.has(item));
}

export function union<T>(arr1: T[], arr2: T[]): T[] {
  return uniq([...arr1, ...arr2]);
}

export function pluck<T, K extends keyof T>(array: T[], key: K): T[K][] {
  return array.map((item) => item[key]);
}

export function compact<T>(array: (T | null | undefined)[]): T[] {
  return array.filter((item): item is T => item != null);
}

export function take<T>(array: T[], n: number): T[] {
  return array.slice(0, n);
}

export function drop<T>(array: T[], n: number): T[] {
  return array.slice(n);
}

export function sum(array: number[]): number {
  return array.reduce((acc, val) => acc + val, 0);
}

export function average(array: number[]): number {
  if (array.length === 0) return 0;
  return sum(array) / array.length;
}

export function min(array: number[]): number | undefined {
  if (array.length === 0) return undefined;
  return Math.min(...array);
}

export function max(array: number[]): number | undefined {
  if (array.length === 0) return undefined;
  return Math.max(...array);
}
