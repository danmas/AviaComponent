import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { ShopScreen } from './screens/ShopScreen.tsx';
import './styles.css';

const host = document.getElementById('root');
if (host === null) {
  throw new Error('Нет узла #root.');
}

createRoot(host).render(
  <StrictMode>
    <ShopScreen />
  </StrictMode>,
);
