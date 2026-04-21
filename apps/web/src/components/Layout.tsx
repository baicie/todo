import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { Outlet } from 'react-router-dom';
import { OfflineIndicator } from './OfflineIndicator';

export const Layout = () => {
  return (
    <>
      <a href="#main-content" className="skip-link">
        跳过导航
      </a>
      <div className="flex flex-col w-screen h-screen overflow-hidden bg-white text-gray-900 font-sans">
        <OfflineIndicator />
        <Header />
        <div className="flex flex-1 overflow-hidden">
          <Sidebar />
          <main
            id="main-content"
            tabIndex={-1}
            className="flex-1 flex flex-col overflow-hidden focus:outline-none"
          >
            <Outlet />
          </main>
        </div>
      </div>
    </>
  );
};
