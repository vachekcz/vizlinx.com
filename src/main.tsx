import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initialTheme } from './themes';
import './styles.css';
import './themes.css';

document.documentElement.dataset.theme = initialTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
