const RESERVE_FRACTION = 0.15;   // keep this fraction of the dashboard's "miles to empty" as a cushion
const METERS_PER_MILE = 1609.34;
const CRITICAL_LOW_MILES = 20; // below this, treat as urgent and ignore the reserve cushion
const RESULTS_COUNT = 3; // show this many lowest-price reachable options, not just one

let knownLocation = null; // filled in lazily to bias destination suggestions
let autocompleteSessionToken = null;
let autocompleteAbortController = null;
let autocompleteDebounceTimer = null;

function initVehicleForm() {
  const destInput = document.getElementById('destination');
  const savedDest = localStorage.getItem('gp_last_destination');
  if (savedDest) destInput.value = savedDest;

  initDestinationAutocomplete();

  // Quietly try to get location up front (non-blocking) so autocomplete can
  // bias suggestions toward nearby places. If denied, autocomplete still
  // works, just without the bias, and the real GPS fetch on submit still runs.
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => { knownLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude }; },
      () => {},
      { maximumAge: 300000, timeout: 5000 }
    );
  }
}

function newSessionToken() {
  return (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
}

function initDestinationAutocomplete() {
  const destInput = document.getElementById('destination');
  const list = document.getElementById('autocompleteList');

  function hideList() {
    list.classList.remove('visible');
    list.innerHTML = '';
  }

  function renderSuggestions(suggestions) {
    if (!suggestions.length) { hideList(); return; }
    list.innerHTML = suggestions.map((s, i) => `
      <div class="autocomplete-item" data-index="${i}">
        <div class="autocomplete-item-main">${escapeHtml(s.mainText)}</div>
        ${s.secondaryText ? `<div class="autocomplete-item-sub">${escapeHtml(s.secondaryText)}</div>` : ''}
      </div>
    `).join('');
    list.querySelectorAll('.autocomplete-item').forEach((el, i) => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        destInput.value = suggestions[i].text;
        localStorage.setItem('gp_last_destination', suggestions[i].text);
        hideList();
        autocompleteSessionToken = null; // selection made — next query starts a fresh session
      });
    });
    list.classList.add('visible');
  }

  destInput.addEventListener('input', () => {
    const value = destInput.value.trim();
    clearTimeout(autocompleteDebounceTimer);
    if (value.length < 3) { hideList(); return; }
    if (!autocompleteSessionToken) autocompleteSessionToken = newSessionToken();

    autocompleteDebounceTimer = setTimeout(async () => {
      if (autocompleteAbortController) autocompleteAbortController.abort();
      autocompleteAbortController = new AbortController();
      try {
        const res = await fetch('/.netlify/functions/autocomplete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            input: value,
            sessionToken: autocompleteSessionToken,
            origin: knownLocation || undefined,
          }),
          signal: autocompleteAbortController.signal,
        });
        const data = await res.json();
        if (destInput.value.trim() === value) renderSuggestions(data.suggestions || []);
      } catch (e) {}
    }, 250);
  });

  destInput.addEventListener('blur', () => setTimeout(hideList, 150));
}

function showError(msg) {
  const el = document.getElementById('errorMsg');
  el.textContent = msg;
  el.classList.add('visible');
}
function clearError() {
  const el = document.getElementById('errorMsg');
  el.classList.remove('visible');
}

function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Location isn’t supported on this device.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          reject(new Error('Location access was denied. Allow location for GasPicker in your browser settings, then try again.'));
        } else {
          reject(new Error('Couldn’t get your current location. Try again in a moment.'));
        }
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    );
  });
}

function setLoading(msg) {
  const area = document.getElementById('loadingArea');
  if (!msg) { area.innerHTML = ''; return; }
  area.innerHTML = `<div class="card loading-center"><div class="spinner"></div><div>${msg}</div></div>`;
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}

async function handleFindStop() {
  clearError();
  document.getElementById('resultsArea').innerHTML = '';

  const milesToEmptyInput = document.getElementById('milesToEmpty');
  const destInput = document.getElementById('destination');

  const milesToEmpty = parseFloat(milesToEmptyInput.value) || null;

  if (!milesToEmpty) {
    showError('Enter your miles-to-empty from your dashboard.');
    return;
  }
  if (!destInput.value.trim()) {
    showError('Enter where you’re headed.');
    return;
  }
  localStorage.setItem('gp_last_destination', destInput.value.trim());

  const findBtn = document.getElementById('findBtn');
  findBtn.disabled = true;

  try {
    setLoading('Getting your location...');
    const origin = await getLocation();

    setLoading('Mapping your route...');
    const route = await postJson('/.netlify/functions/get-route', {
      origin,
      destination: destInput.value.trim(),
    });

    const isCriticallyLow = milesToEmpty <= CRITICAL_LOW_MILES;
    const comfortableMaxRangeMeters = milesToEmpty * (1 - RESERVE_FRACTION) * METERS_PER_MILE;
    const absoluteMaxRangeMeters = milesToEmpty * METERS_PER_MILE;

    if (!isCriticallyLow && comfortableMaxRangeMeters >= route.distanceMeters) {
      const cushionMiles = milesToEmpty - milesFromMeters(route.distanceMeters);
      renderNoStopNeeded(cushionMiles);
      setLoading('');
      findBtn.disabled = false;
      return;
    }

    const searchUpperBoundMeters = isCriticallyLow
      ? Math.min(absoluteMaxRangeMeters, route.distanceMeters)
      : Math.min(comfortableMaxRangeMeters, route.distanceMeters);

    const reachableSamples = route.samples.filter((s) => s.distanceMeters <= searchUpperBoundMeters);
    if (reachableSamples.length === 0) reachableSamples.push(route.samples[0]);

    setLoading('Finding gas stations along your route...');
    const stationsRes = await postJson('/.netlify/functions/find-stations', {
      points: reachableSamples.map((s) => ({ lat: s.lat, lng: s.lng, distanceMeters: s.distanceMeters, durationSeconds: s.durationSeconds })),
    });

    if (!stationsRes.stations || stationsRes.stations.length === 0) {
      setLoading('');
      renderNoStationsFound(isCriticallyLow);
      findBtn.disabled = false;
      return;
    }

    setLoading('Checking fuel prices...');
    const pricesRes = await postJson('/.netlify/functions/get-prices', {
      stations: stationsRes.stations.map((s) => ({ placeId: s.placeId, lat: s.lat, lng: s.lng })),
    });
    const priceByPlaceId = {};
    (pricesRes.prices || []).forEach((p) => { priceByPlaceId[p.placeId] = p; });

    // Stations are already limited to a small detour from the route (the
    // backend only searches near sampled route points), so among reachable
    // stations we just rank by price — letting the driver weigh brand or
    // store preference themselves across the cheapest few, rather than
    // silently picking one "best" stop for them.
    const candidates = stationsRes.stations
      .map((s) => {
        const priceInfo = priceByPlaceId[s.placeId];
        if (!priceInfo) return null;
        const detourMiles = s.detourMeters ? milesFromMeters(s.detourMeters) : 0.6;
        return { ...s, ...priceInfo, detourMiles };
      })
      .filter(Boolean)
      .sort((a, b) => a.price - b.price);

    setLoading('');

    if (candidates.length === 0) {
      renderNoStationsFound(isCriticallyLow);
      findBtn.disabled = false;
      return;
    }

    renderResults(candidates.slice(0, RESULTS_COUNT), isCriticallyLow);
  } catch (err) {
    setLoading('');
    showError(err.message || 'Something went wrong. Please try again.');
  }

  findBtn.disabled = false;
}

function renderNoStopNeeded(cushionMiles) {
  const area = document.getElementById('resultsArea');
  area.innerHTML = `
    <div class="card notice notice-success" style="margin-bottom:16px;">
      <strong>You've got enough range to make it.</strong><br>
      You should arrive with roughly ${Math.max(0, Math.round(cushionMiles))} miles of range left — no stop needed for this trip.
    </div>
  `;
}

function renderNoStationsFound(isCriticallyLow) {
  const area = document.getElementById('resultsArea');
  area.innerHTML = `
    <div class="card notice" style="margin-bottom:16px;">
      ${isCriticallyLow ? 'You’re very low on fuel and ' : ''}We couldn’t find a gas station with recent enough map data within your reachable range. Try a nearby town name as your destination, or check a maps app directly.
    </div>
  `;
}

function confidenceInfo(confidence) {
  if (confidence === 'high') return { cls: 'confidence-high', label: '✓ Price confirmed recently' };
  if (confidence === 'medium') return { cls: 'confidence-medium', label: '~ Price from a few days ago' };
  return { cls: 'confidence-low', label: '≈ Estimated — no recent driver reports' };
}

const RANK_LABELS = ['#1 · Cheapest reachable', '#2 · Next cheapest', '#3 · Next cheapest'];

function renderResults(candidates, isCriticallyLow) {
  const area = document.getElementById('resultsArea');

  const cardsHtml = candidates.map((c, i) => {
    const conf = confidenceInfo(c.confidence);
    const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${c.lat},${c.lng}&query_place_id=${encodeURIComponent(c.placeId)}`;
    return `
      <div class="result-card" data-index="${i}">
        <div class="result-eyebrow">${RANK_LABELS[i] || `#${i + 1}`}</div>
        <div class="result-station">${escapeHtml(c.name)}</div>
        <div class="result-address">${escapeHtml(c.address || '')}</div>

        <div class="confidence-tag ${conf.cls}">${conf.label}</div>

        <div class="result-stats">
          <div class="result-stat-box">
            <div class="result-stat-label">Price</div>
            <div class="result-stat-value">${formatMoney(c.price)}/gal</div>
          </div>
          <div class="result-stat-box">
            <div class="result-stat-label">Off your route</div>
            <div class="result-stat-value">${c.detourMiles < 0.15 ? 'Right on it' : `~${c.detourMiles.toFixed(1)} mi`}</div>
          </div>
        </div>

        <div class="result-stat-box" style="margin-bottom:16px;">
          <div class="result-stat-label">Time to stop</div>
          <div class="result-stat-value">${formatTimeFromNow(c.durationSeconds)}</div>
        </div>

        <div class="result-actions">
          <a class="btn btn-primary" href="${mapsUrl}" target="_blank" rel="noopener">Get Directions</a>
        </div>

        <div class="report-toggle" data-report-toggle="${i}">Price wrong? Report what you actually paid</div>
        <div class="report-form" data-report-form="${i}">
          <input type="number" data-report-price="${i}" inputmode="decimal" placeholder="3.29" step="0.01" min="1" max="9">
          <button class="btn btn-primary btn-sm" data-report-submit="${i}">Submit</button>
        </div>
      </div>
    `;
  }).join('');

  area.innerHTML = `
    ${isCriticallyLow ? '<div class="notice">You’re low on fuel — these are your closest reachable options, not necessarily the cheapest anywhere.</div>' : ''}
    ${cardsHtml}
    <button type="button" class="btn btn-outline" id="findAgainBtn" style="margin-bottom:16px;">Search Again</button>
  `;

  document.getElementById('findAgainBtn').addEventListener('click', () => {
    document.getElementById('resultsArea').innerHTML = '';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  candidates.forEach((c, i) => {
    const toggle = area.querySelector(`[data-report-toggle="${i}"]`);
    const form = area.querySelector(`[data-report-form="${i}"]`);
    toggle.addEventListener('click', () => form.classList.toggle('visible'));

    area.querySelector(`[data-report-submit="${i}"]`).addEventListener('click', async () => {
      const priceInput = area.querySelector(`[data-report-price="${i}"]`);
      const price = parseFloat(priceInput.value);
      if (!price || price < 1 || price > 9) return;
      try {
        await postJson('/.netlify/functions/submit-price', {
          placeId: c.placeId,
          name: c.name,
          lat: c.lat,
          lng: c.lng,
          price,
        });
        form.innerHTML = '<div style="font-size:13px; color: var(--success);">Thanks — that helps other drivers.</div>';
      } catch (e) {}
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

document.addEventListener('DOMContentLoaded', () => {
  initVehicleForm();
  setupInstallBanner();
  document.getElementById('findBtn').addEventListener('click', handleFindStop);
});
