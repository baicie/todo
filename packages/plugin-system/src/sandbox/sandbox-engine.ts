/**
 * Orbit 插件系统 — 沙箱执行引擎
 *
 * 提供一个受限的 JavaScript 执行环境，运行插件代码。
 * 当前实现为轻量级函数作用域隔离，后续可升级为 vm2 / iframe 隔离。
 */

export interface SandboxOptions {
  timeout?: number;
  onError?: (error: Error) => void;
}

export interface SandboxResult<T = unknown> {
  success: boolean;
  result?: T;
  error?: string;
}

const DEFAULT_TIMEOUT = 5000;

export function createSandbox(options: SandboxOptions = {}) {
  const { timeout = DEFAULT_TIMEOUT, onError } = options;

  /**
   * 在受限环境中执行插件代码
   * @param code 插件入口代码
   * @param context 注入到插件的上下文（pluginApi 等）
   * @returns 执行结果
   */
  async function execute<T = unknown>(
    code: string,
    context: Record<string, unknown>,
  ): Promise<SandboxResult<T>> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({ success: false, error: 'Plugin execution timed out' });
      }, timeout);

      try {
        const fn = new Function(...Object.keys(context), `"use strict";\n${code}`);
        const result = fn(...Object.values(context));

        if (result instanceof Promise) {
          result
            .then((value) => {
              clearTimeout(timer);
              resolve({ success: true, result: value as T });
            })
            .catch((err: Error) => {
              clearTimeout(timer);
              const message = err?.message ?? String(err);
              onError?.(err);
              resolve({ success: false, error: message });
            });
        } else {
          clearTimeout(timer);
          resolve({ success: true, result: result as T });
        }
      } catch (err: unknown) {
        clearTimeout(timer);
        const error = err as Error;
        const message = error?.message ?? String(err);
        onError?.(error);
        resolve({ success: false, error: message });
      }
    });
  }

  return { execute };
}

export function createPluginSandbox() {
  return createSandbox();
}
