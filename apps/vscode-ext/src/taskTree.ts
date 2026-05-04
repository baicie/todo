import * as vscode from 'vscode';
import type { Task } from '@baicie/orbit';
import * as storage from './storage-adapter';

export class TaskTreeProvider implements vscode.TreeDataProvider<TaskTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TaskTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private tasks: Task[] = [];

  async refresh() {
    this.tasks = await storage.getTasks();
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TaskTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(_element?: TaskTreeItem): Promise<TaskTreeItem[]> {
    const activeTasks = this.tasks.filter((t) => !t.isCompleted);
    return activeTasks.map((t) => new TaskTreeItem(t));
  }

  async getAllTasks(): Promise<Task[]> {
    this.tasks = await storage.getTasks();
    return this.tasks;
  }
}

export class TaskTreeItem extends vscode.TreeItem {
  constructor(public readonly task: Task) {
    super(task.title, vscode.TreeItemCollapsibleState.None);

    this.tooltip = `${task.title}${task.description ? `\n\n${task.description}` : ''}`;
    this.description = task.isCompleted ? '(已完成)' : '';

    if (task.isImportant) {
      this.iconPath = new vscode.ThemeIcon(
        'star-fill',
        new vscode.ThemeColor('editorWarning.foreground'),
      );
    } else {
      this.iconPath = new vscode.ThemeIcon(
        task.isCompleted ? 'check' : 'circle',
        task.isCompleted ? new vscode.ThemeColor('charts.green') : undefined,
      );
    }

    this.contextValue = 'task';
    this.command = {
      command: 'orbit-vscode-ext.viewTask',
      title: 'View Task',
      arguments: [task],
    };
  }
}
