/**
 * Orbit 插件系统 — 工作流自动化引擎
 *
 * 工作流由触发器（Trigger）+ 条件（Condition）+ 动作（Action）构成。
 * 支持的触发器类型：
 *   - task.created    — 任务创建时
 *   - task.completed  — 任务完成时
 *   - task.dueSoon    — 任务即将到期时（到期前 N 小时）
 *   - task.overdue    — 任务逾期时
 */

export type WorkflowTriggerType =
  | 'task.created'
  | 'task.completed'
  | 'task.dueSoon'
  | 'task.overdue';

export type WorkflowConditionOperator = 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains';

export interface WorkflowCondition {
  field: string;
  operator: WorkflowConditionOperator;
  value: unknown;
}

export interface WorkflowAction {
  type: 'notify' | 'webhook' | 'updateField' | 'moveToList' | 'addTag' | 'removeTag';
  config: Record<string, unknown>;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  trigger: WorkflowTriggerType;
  triggerConfig?: {
    listId?: string;
    hoursBefore?: number;
  };
  conditions: WorkflowCondition[];
  actions: WorkflowAction[];
  isActive: boolean;
  pluginId: string;
  createdAt: string;
}

type TriggerHandler = (data: WorkflowEventData) => void;

interface WorkflowEventData {
  type: WorkflowTriggerType;
  taskId: string;
  task?: Record<string, unknown>;
  userId?: number;
  timestamp: string;
}

const triggerHandlers = new Map<WorkflowTriggerType, Set<TriggerHandler>>();

const activeWorkflows: WorkflowDefinition[] = [];

export function registerWorkflow(workflow: WorkflowDefinition): void {
  const existing = activeWorkflows.findIndex((w) => w.id === workflow.id);
  if (existing >= 0) {
    activeWorkflows[existing] = workflow;
    return;
  }
  activeWorkflows.push(workflow);
}

export function unregisterWorkflow(workflowId: string): void {
  const idx = activeWorkflows.findIndex((w) => w.id === workflowId);
  if (idx >= 0) activeWorkflows.splice(idx, 1);
}

export function getActiveWorkflows(): WorkflowDefinition[] {
  return activeWorkflows.filter((w) => w.isActive);
}

export function subscribeTrigger(type: WorkflowTriggerType, handler: TriggerHandler): () => void {
  if (!triggerHandlers.has(type)) {
    triggerHandlers.set(type, new Set());
  }
  triggerHandlers.get(type)!.add(handler);
  return () => {
    triggerHandlers.get(type)?.delete(handler);
  };
}

function evaluateCondition(condition: WorkflowCondition, task: Record<string, unknown>): boolean {
  const fieldValue = getNestedValue(task, condition.field);
  const { operator, value } = condition;

  switch (operator) {
    case 'eq':
      return fieldValue === value;
    case 'neq':
      return fieldValue !== value;
    case 'gt':
      return Number(fieldValue) > Number(value);
    case 'lt':
      return Number(fieldValue) < Number(value);
    case 'gte':
      return Number(fieldValue) >= Number(value);
    case 'lte':
      return Number(fieldValue) <= Number(value);
    case 'contains':
      return String(fieldValue).includes(String(value));
    default:
      return false;
  }
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in acc) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

function evaluateAllConditions(
  conditions: WorkflowCondition[],
  task: Record<string, unknown>,
): boolean {
  if (conditions.length === 0) return true;
  return conditions.every((c) => evaluateCondition(c, task));
}

async function executeAction(
  action: WorkflowAction,
  taskId: string,
  task: Record<string, unknown>,
): Promise<void> {
  switch (action.type) {
    case 'notify':
      if (typeof window !== 'undefined' && 'Notification' in window) {
        new window.Notification(String(action.config.title ?? 'Orbit'), {
          body: String(action.config.body ?? ''),
          icon: String(action.config.icon ?? ''),
        });
      }
      break;

    case 'webhook': {
      const url = String(action.config.url ?? '');
      const method = String(action.config.method ?? 'POST');
      const headers = (action.config.headers as Record<string, string>) ?? {};
      const body = action.config.body
        ? JSON.stringify(action.config.body)
        : JSON.stringify({ taskId, task });
      try {
        await fetch(url, { method, headers, body, keepalive: true });
      } catch (err) {
        console.warn('[Workflow] Webhook failed:', err);
      }
      break;
    }

    case 'updateField':
      console.info(
        `[Workflow] updateField: set ${String(action.config.field)} = ${String(action.config.value)} on task ${taskId}`,
      );
      break;

    case 'moveToList':
      console.info(
        `[Workflow] moveToList: move task ${taskId} to list ${String(action.config.listId)}`,
      );
      break;

    case 'addTag':
      console.info(`[Workflow] addTag: add tag ${String(action.config.tagId)} to task ${taskId}`);
      break;

    case 'removeTag':
      console.info(
        `[Workflow] removeTag: remove tag ${String(action.config.tagId)} from task ${taskId}`,
      );
      break;
  }
}

export async function triggerWorkflow(
  type: WorkflowTriggerType,
  data: Omit<WorkflowEventData, 'type' | 'timestamp'>,
): Promise<void> {
  const eventData: WorkflowEventData = {
    type,
    ...data,
    timestamp: new Date().toISOString(),
  };

  const handlers = triggerHandlers.get(type);
  if (handlers) {
    for (const handler of handlers) {
      try {
        handler(eventData);
      } catch (err) {
        console.warn(`[Workflow] Trigger handler error for "${type}":`, err);
      }
    }
  }

  const matchingWorkflows = activeWorkflows.filter((wf) => {
    if (wf.trigger !== type) return false;
    if (wf.triggerConfig?.listId && data.task && data.task['listId'] !== wf.triggerConfig.listId)
      return false;
    if (!evaluateAllConditions(wf.conditions, data.task ?? {})) return false;
    return true;
  });

  for (const workflow of matchingWorkflows) {
    for (const action of workflow.actions) {
      try {
        await executeAction(action, data.taskId, data.task ?? {});
      } catch (err) {
        console.warn(`[Workflow] Action execution error in workflow "${workflow.name}":`, err);
      }
    }
  }
}

export function getWorkflowsByPlugin(pluginId: string): WorkflowDefinition[] {
  return activeWorkflows.filter((w) => w.pluginId === pluginId);
}

export function getWorkflowsByTrigger(type: WorkflowTriggerType): WorkflowDefinition[] {
  return activeWorkflows.filter((w) => w.trigger === type && w.isActive);
}
