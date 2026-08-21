import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { IS_DEMO } from './lib/api';
import { setSoundUrlResolver, unlockAudio } from './lib/audio/player';
import { initNative, IS_NATIVE_BUILD, isNative } from './lib/native/bridge';
import { apiUrl } from './lib/native/endpoint';
import './styles/global.css';
import './styles/app.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element is missing from index.html');

if (IS_DEMO) {
  // Uploaded alarm sounds are blob URLs held by the in-browser backend.
  void import('./lib/demo/api').then(({ demoSoundUrl }) => setSoundUrlResolver(demoSoundUrl));
} else if (IS_NATIVE_BUILD) {
  // The phone build talks to a server on another origin, so a sound's URL has
  // to be absolute; the default resolver assumes it shares an origin.
  setSoundUrlResolver((soundId) => apiUrl(`/sounds/${soundId}/audio`));
}

// Which platform this is has to be settled before anything asks, because the
// answer decides whether alarms are scheduled with the OS or with a ticker.
const nativeReady = initNative();

void nativeReady.then(async () => {
  if (!isNative()) return;
  const { initNativeShell } = await import('./lib/native/shell');
  await initNativeShell();
});

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

// Not in the phone builds. A service worker there would duplicate work the
// OS already does — the app is installed, its files are local, and alarms are
// scheduled with the system rather than with a background script.
if ('serviceWorker' in navigator && import.meta.env.PROD && !IS_NATIVE_BUILD) {
  window.addEventListener('load', () => {
    // BASE_URL so the worker registers correctly under a project sub-path
    // such as /reminder/ on GitHub Pages.
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      // Offline support and background notifications are a bonus; the app
      // works without them.
    });
  });
}
