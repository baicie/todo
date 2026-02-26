import { useState } from 'react';
import { Sidebar } from './Sidebar';
import { MainContent } from './MainContent';

export const Layout = () => {
  const [activeListId, setActiveListId] = useState('my-day');

  return (
    <div className="flex w-screen h-screen overflow-hidden bg-white text-gray-900 font-sans">
      <Sidebar activeListId={activeListId} onListSelect={setActiveListId} />
      <MainContent activeListId={activeListId} />
    </div>
  );
};
