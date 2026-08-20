import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { IS_DEMO } from './lib/api';
import { setSoundUrlResolver, unlockAudio } from './lib/audio/player';
import './styles/global.css';
import './styles/app.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element is missing from index.html');

if (IS_DEMO) {
  // Uploaded alarm sounds are blob URLs held by the in-browser backend.
  void import('./lib/demo/api').then(({ demoSoundUrl }) => setSoundUrlResolver(demoSoundUrl));
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The very first interaction anywhere on the page is enough to satisfy the
// browser's autoplay policy, so alarms can make sound later without the user
// having to press anything specific.
const primeAudio = () => {
  void unlockAudio();
};
window.addEventListener('pointerdown', primeAudio, { once: true });
window.addEventListener('keydown', primeAudio, { once: true });

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    // BASE_URL so the worker registers correctly under a project sub-path
    // such as /reminder/ on GitHub Pages.
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      // Offline support and background notifications are a bonus; the app
      // works without them.
    });
  });
}
