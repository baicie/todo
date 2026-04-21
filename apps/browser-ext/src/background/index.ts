// Background Service Worker
// 处理扩展生命周期事件、快捷键、上下文菜单

// 快捷键命令处理
chrome.commands.onCommand.addListener((command) => {
  if (command === '_execute_action') {
    // 打开 popup 或创建一个新的 tab
    chrome.action.openPopup().catch(() => {
      chrome.tabs.create({ url: 'popup.html' });
    });
  }
});

// 上下文菜单
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'add-to-unitodo',
    title: '添加到 UniTodo',
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'add-to-unitodo' && info.selectionText) {
    // 发送消息到 popup 或 content script
    chrome.runtime.sendMessage({
      type: 'ADD_TASK',
      text: info.selectionText,
    });
  }
});

// 监听来自 popup 和 content script 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'GET_TASKS':
      // 从 storage 获取任务列表
      chrome.storage.local.get(['unitodo_tasks'], (result) => {
        sendResponse({ tasks: result.unitodo_tasks || [] });
      });
      return true; // 异步响应

    case 'SAVE_TASK':
      chrome.storage.local.get(['unitodo_tasks'], (result: Record<string, unknown>) => {
        const tasks: unknown[] = Array.isArray(result.unitodo_tasks) ? result.unitodo_tasks : [];
        tasks.unshift(message.task);
        chrome.storage.local.set({ unitodo_tasks: tasks }, () => {
          sendResponse({ success: true });
        });
      });
      return true;

    case 'SHOW_NOTIFICATION':
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon-48.png',
        title: message.title || 'UniTodo',
        message: message.body || '',
        priority: 2,
      });
      sendResponse({ success: true });
      return false;

    default:
      return false;
  }
});

// 安装时打印日志
console.log('[UniTodo] Background service worker started');
