import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import ConnectionLab from './ConnectionLab';
import ScanWorkspace from './ScanWorkspace';
import { initialTheme } from './themes';
import './styles.css';
import './themes.css';

document.documentElement.dataset.theme = initialTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {window.location.pathname.replace(/\/$/, '') === '/connections/lab' ? (
      <ConnectionLab />
    ) : window.location.pathname.replace(/\/$/, '') === '/scan' ? (
      <ScanWorkspace />
    ) : (
      <App />
    )}
  </StrictMode>,
);
