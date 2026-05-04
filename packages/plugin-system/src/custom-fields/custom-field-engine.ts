/**
 * Orbit 插件系统 — 自定义字段管理
 *
 * 允许插件注册自定义字段，扩展 Task 数据结构。
 * 字段数据存储在 task.pluginData[pluginId] 命名空间下。
 */

import type { CustomFieldDefinition } from '../types';

interface FieldRegistryEntry {
  definition: CustomFieldDefinition;
  pluginId: string;
}

const fieldRegistry = new Map<string, FieldRegistryEntry>();

export function registerCustomFields(pluginId: string, fields: CustomFieldDefinition[]): void {
  for (const field of fields) {
    const key = `${pluginId}:${field.key}`;
    fieldRegistry.set(key, { definition: field, pluginId });
  }
}

export function unregisterCustomFields(pluginId: string): void {
  for (const [key, entry] of fieldRegistry.entries()) {
    if (entry.pluginId === pluginId) {
      fieldRegistry.delete(key);
    }
  }
}

export function getCustomField(key: string, pluginId: string): CustomFieldDefinition | undefined {
  return fieldRegistry.get(`${pluginId}:${key}`)?.definition;
}

export function getAllCustomFields(): CustomFieldDefinition[] {
  return Array.from(fieldRegistry.values()).map((e) => e.definition);
}

export function getCustomFieldsForPlugin(pluginId: string): CustomFieldDefinition[] {
  return Array.from(fieldRegistry.values())
    .filter((e) => e.pluginId === pluginId)
    .map((e) => e.definition);
}

export function getCustomFieldsByKeys(keys: string[], pluginId: string): CustomFieldDefinition[] {
  return keys
    .map((key) => fieldRegistry.get(`${pluginId}:${key}`)?.definition)
    .filter((f): f is CustomFieldDefinition => f !== undefined);
}

/**
 * 从 task.pluginData 中读取插件字段值
 */
export function getPluginFieldValue(
  pluginData: Record<string, Record<string, unknown>> | undefined,
  pluginId: string,
  fieldKey: string,
): unknown {
  return pluginData?.[pluginId]?.[fieldKey];
}

/**
 * 验证字段值是否符合字段定义
 */
export function validateFieldValue(
  definition: CustomFieldDefinition,
  value: unknown,
): { valid: boolean; error?: string } {
  switch (definition.type) {
    case 'number':
      if (typeof value !== 'number') return { valid: false, error: '值必须是数字' };
      if (definition.min !== undefined && value < definition.min) {
        return { valid: false, error: `值不能小于 ${definition.min}` };
      }
      if (definition.max !== undefined && value > definition.max) {
        return { valid: false, error: `值不能大于 ${definition.max}` };
      }
      return { valid: true };
    case 'select':
      if (definition.options && !definition.options.includes(String(value))) {
        return { valid: false, error: `值必须是 ${definition.options.join(' | ')} 之一` };
      }
      return { valid: true };
    case 'checkbox':
      if (typeof value !== 'boolean') return { valid: false, error: '值必须是布尔值' };
      return { valid: true };
    case 'date':
      if (isNaN(Date.parse(String(value)))) return { valid: false, error: '值必须是有效日期' };
      return { valid: true };
    case 'text':
    default:
      if (definition.required && !value) return { valid: false, error: '此字段为必填' };
      return { valid: true };
  }
}
