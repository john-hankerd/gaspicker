function appUrl(path) {
  return new URL(path, window.location.href).toString();
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
}

function setupInstallBanner() {
  let deferredPrompt = null;
  const banner = document.getElementById('installBanner');
  const btn = document.getElementById('installBannerBtn');
  const closeBtn = document.getElementById('installBannerClose');
  if (!banner || !btn || !closeBtn) return;

  if (localStorage.getItem('fs_install_dismissed') === '1') return;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    banner.style.display = 'block';
  });

  btn.addEventListener('click', async () => {
    banner.style.display = 'none';
    if (deferredPrompt) {
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
    }
  });

  closeBtn.addEventListener('click', () => {
    banner.style.display = 'none';
    localStorage.setItem('fs_install_dismissed', '1');
  });
}

function formatMoney(n) {
  return '$' + n.toFixed(2);
}

function formatTimeFromNow(seconds) {
  const arrival = new Date(Date.now() + seconds * 1000);
  const mins = Math.round(seconds / 60);
  const timeStr = arrival.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (mins < 60) return `In about ${mins} min (around ${timeStr})`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return `In about ${hrs}h ${rem}m (around ${timeStr})`;
}

function milesFromMeters(m) {
  return m / 1609.34;
}

registerServiceWorker();
