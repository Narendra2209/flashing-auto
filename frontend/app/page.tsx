'use client';

import { useState } from 'react';
import TopBar from './components/TopBar';
import TabBar from './components/TabBar';
import FlashingTab from './components/FlashingTab';
import RoofingTab from './components/RoofingTab';
import type { Tab } from './lib/types';

export default function Page() {
  const [tab, setTab] = useState<Tab>('flashing');

  return (
    <>
      <TopBar />
      <TabBar active={tab} onChange={setTab} />
      {tab === 'flashing' && <FlashingTab />}
      {tab === 'roofing' && <RoofingTab />}
    </>
  );
}
