import {createRoot} from 'react-dom/client';
import {registerSW} from 'virtual:pwa-register';
import App from './App.tsx';
import './index.css';

registerSW({
  immediate: true,
  onOfflineReady() {
    console.info('[AurumEA PWA] Aplikasi siap diakses offline di Android/Desktop.');
  },
});

createRoot(document.getElementById('root')!).render(<App />);
