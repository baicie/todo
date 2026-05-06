export function extend<T extends Record<string, unknown>, U extends Record<string, unknown>>(
  target: T,
  ...sources: U[]
): T & U {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = {};
  for (const key of Object.keys(target) as Array<keyof T>) {
    result[key] = target[key];
  }
  for (const source of sources) {
    for (const key of Object.keys(source) as Array<keyof U>) {
      result[key] = source[key];
    }
  }
  return result as T & U;
}
