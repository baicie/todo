const SUBSCRIPTION_KEY = 'shishi.push.endpoint';

function urlBase64ToUint8Array(value: string): Uint8Array {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

export function webPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export async function subscribeWebPush(publicKey: string): Promise<{
  endpoint: string;
  p256dh: string;
  auth: string;
}> {
  if (!webPushSupported()) throw new Error('当前浏览器不支持网页推送');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('通知权限未开启');
  const registration = await navigator.serviceWorker.register('/sw.js');
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    }));
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
    throw new Error('浏览器没有返回完整的推送订阅');
  }
  localStorage.setItem(SUBSCRIPTION_KEY, json.endpoint);
  return {
    endpoint: json.endpoint,
    p256dh: json.keys.p256dh,
    auth: json.keys.auth,
  };
}

export async function unsubscribeWebPush(): Promise<string | null> {
  const registration = await navigator.serviceWorker.getRegistration('/sw.js');
  const subscription = await registration?.pushManager.getSubscription();
  const endpoint = subscription?.endpoint ?? localStorage.getItem(SUBSCRIPTION_KEY);
  if (subscription) await subscription.unsubscribe();
  localStorage.removeItem(SUBSCRIPTION_KEY);
  return endpoint;
}
