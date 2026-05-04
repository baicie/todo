import * as vscode from 'vscode';
import { TaskTreeProvider } from './taskTree';
import * as storage from './storage-adapter';

let taskTreeProvider: TaskTreeProvider;

export function activate(_context: vscode.ExtensionContext) {
  taskTreeProvider = new TaskTreeProvider();
  void taskTreeProvider.refresh();

  vscode.window.registerTreeDataProvider('orbitTasks', taskTreeProvider);

  const disposable = vscode.commands.registerCommand('orbit-vscode-ext.helloWorld', async () => {
    const tasks = await storage.getTasks();
    const taskCount = tasks.length;
    const completedCount = tasks.filter((t) => t.isCompleted).length;
    void vscode.window.showInformationMessage(
      `Orbit Tasks: ${taskCount} total, ${completedCount} completed`,
    );
  });

  const addTaskCmd = vscode.commands.registerCommand('orbit-vscode-ext.addTask', async () => {
    const input = await vscode.window.showInputBox({
      prompt: 'Enter new task title',
      placeHolder: 'Task title',
    });
    if (!input?.trim()) return;

    await storage.createTask(input.trim());
    void taskTreeProvider.refresh();
    void vscode.window.showInformationMessage(`Task added: ${input.trim()}`);
  });

  const viewTaskCmd = vscode.commands.registerCommand(
    'orbit-vscode-ext.viewTask',
    async (task: import('@baicie/orbit').Task) => {
      const actions = ['标记完成', '标记重要', '删除'];
      const choice = await vscode.window.showQuickPick(actions, {
        placeHolder: `Task: ${task.title}`,
      });

      if (!choice) return;

      if (choice === '标记完成') {
        await storage.updateTask(task.id, { isCompleted: !task.isCompleted });
        void taskTreeProvider.refresh();
      } else if (choice === '标记重要') {
        await storage.updateTask(task.id, { isImportant: !task.isImportant });
        void taskTreeProvider.refresh();
      } else if (choice === '删除') {
        await storage.deleteTask(task.id);
        void taskTreeProvider.refresh();
        void vscode.window.showInformationMessage('Task deleted');
      }
    },
  );

  const refreshCmd = vscode.commands.registerCommand('orbit-vscode-ext.refreshTasks', async () => {
    await taskTreeProvider.refresh();
  });

  _context.subscriptions.push(disposable, addTaskCmd, viewTaskCmd, refreshCmd);
}

export function deactivate() {}
