import { ErrorBoundary } from 'solid-js';
import { render } from 'solid-js/web';
import { App } from './App';
import { createAppPlatform } from './adapters/platform';
import { applyTheme, getThemePreference } from './lib/theme';
import './styles.css';

applyTheme(getThemePreference());

function FatalError(props: { error: unknown }) {
  console.error(props.error);
  return (
    <main class="fatal-screen">
      <div>
        <div class="fatal-screen__mark">!</div>
        <h1>页面遇到了一点问题</h1>
        <p>
          你的本地数据仍在设备上。重新加载通常可以恢复；如仍异常，请从浏览器存储中保留站点数据。
        </p>
        <button type="button" class="primary-button" onClick={() => location.reload()}>
          重新加载
        </button>
      </div>
    </main>
  );
}

async function bootstrap() {
  const root = document.getElementById('root');
  if (!root) throw new Error('Missing #root');
  try {
    const platform = await createAppPlatform();
    render(
      () => (
        <ErrorBoundary fallback={(error) => <FatalError error={error} />}>
          <App platform={platform} />
        </ErrorBoundary>
      ),
      root,
    );
  } catch (error) {
    root.innerHTML = `
      <main style="min-height:100dvh;display:grid;place-items:center;padding:24px;font-family:system-ui;background:#f2f4ef;color:#20251f">
        <div style="max-width:440px;text-align:center">
          <h1 style="font-size:22px;margin:0 0 8px">拾事未能启动</h1>
          <p style="font-size:13px;line-height:1.6;color:#626960;margin:0 0 18px">
            本地数据库无法打开。请检查应用或浏览器的存储权限，确认磁盘空间充足，然后重新加载。
          </p>
          <button style="height:36px;padding:0 14px;border:0;border-radius:8px;background:#3d66d9;color:#fff;font:inherit;cursor:pointer" onclick="location.reload()">
            重新加载
          </button>
        </div>
      </main>`;
  }
}

void bootstrap();
