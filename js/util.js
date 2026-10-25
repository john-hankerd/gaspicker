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

  if (localStorage.getItem('gp_install_dismissed') === '1') return;

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
    localStorage.setItem('gp_install_dismissed', '1');
  });
}

// Station prices are often quoted to a tenth of a cent — the small "9/10" on
// the sign, so $4.79 is stored as 4.799. Number#toFixed rounds half up and
// turns that into "$4.80". Truncate to the cent so the screen matches the sign.
// The 1e-6 absorbs binary float noise (4.79 * 100 can be 478.99999999999994)
// without being large enough to bump a real fractional cent up.
function formatMoney(n) {
  const negative = n < 0;
  const cents = Math.floor(Math.abs(n) * 100 + 1e-6);
  const dollars = Math.floor(cents / 100);
  const rem = cents % 100;
  return (negative ? '-$' : '$') + dollars + '.' + String(rem).padStart(2, '0');
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
