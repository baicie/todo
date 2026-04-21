import * as vscode from 'vscode';
import { add } from '@baicie/orbit-utils';

export function activate(context: vscode.ExtensionContext) {
  console.info('Congratulations, your extension "orbit-vscode-ext" is now active!');

  let disposable = vscode.commands.registerCommand('orbit-vscode-ext.helloWorld', () => {
    vscode.window.showInformationMessage(`Hello World from Orbit! 1 + 2 = ${add(1, 2)}`);
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}
