/**
 * Orbit 插件系统 — 入口文件
 *
 * 提供统一的导出接口，供应用集成。
 */

// Types
export type {
  PluginPermission,
  PluginScope,
  PluginManifest,
  PluginContext,
  CustomFieldDefinition,
  TaskAction,
  SidebarPanel,
  PluginApi,
} from './types';
export type { PluginStatus, PluginInstance } from './host/plugin-host';
export type { SandboxOptions, SandboxResult } from './sandbox/sandbox-engine';
export type {
  WorkflowTriggerType,
  WorkflowConditionOperator,
  WorkflowCondition,
  WorkflowAction,
  WorkflowDefinition,
} from './workflow/workflow-engine';

// Host
export {
  registerPlugin,
  activatePlugin,
  deactivatePlugin,
  removePlugin,
  getPluginInstance,
  getAllPlugins,
  getActivePlugins,
  getPluginsByScope,
  hasPermission,
  addTaskBadgeRenderer,
  addTaskAction,
  addSidebarPanel,
  getTaskBadgeRenderers,
  getTaskActions,
  getSidebarPanels,
} from './host/plugin-host';

// Sandbox
export { createSandbox, createPluginSandbox } from './sandbox/sandbox-engine';

// Custom Fields
export {
  registerCustomFields,
  unregisterCustomFields,
  getCustomField,
  getAllCustomFields,
  getCustomFieldsForPlugin,
  getCustomFieldsByKeys,
  getPluginFieldValue,
  validateFieldValue,
} from './custom-fields/custom-field-engine';

// Workflow
export {
  registerWorkflow,
  unregisterWorkflow,
  getActiveWorkflows,
  subscribeTrigger,
  triggerWorkflow,
  getWorkflowsByPlugin,
  getWorkflowsByTrigger,
} from './workflow/workflow-engine';
