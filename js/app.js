const RESERVE_FRACTION = 0.15;   // keep this fraction of the dashboard's "miles to empty" as a cushion
const FILL_TARGET_FRACTION = 0.90; // assumed fill size when estimating cost: most of the tank, not a precise top-off
const METERS_PER_MILE = 1609.34;
const CRITICAL_LOW_MILES = 20; // below this, treat as urgent and ignore the reserve cushion

let vehicle = loadVehicleProfile();
let knownLocation = null; // filled in lazily to bias destination suggestions
let autocompleteSessionToken = null;
let autocompleteAbortController = null;
let autocompleteDebounceTimer = null;

function loadVehicleProfile() {
  try {
    const raw = localStorage.getItem('gp_vehicle');
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return { tankSize: null };
}

function saveVehicleProfile() {
  localStorage.setItem('gp_vehicle', JSON.stringify(vehicle));
}

function initVehicleForm() {
  const tankInput = document.getElementById('tankSize');
  if (vehicle.tankSize) tankInput.value = vehicle.tankSize;

  tankInput.addEventListener('change', () => {
    vehicle.tankSize = parseFloat(tankInput.value) || null;
    saveVehicleProfile();
  });

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
  const tankInput = document.getElementById('tankSize');
  const destInput = document.getElementById('destination');

  const milesToEmpty = parseFloat(milesToEmptyInput.value) || null;
  vehicle.tankSize = parseFloat(tankInput.value) || null;
  saveVehicleProfile();

  if (!milesToEmpty) {
    showError('Enter your miles-to-empty from your dashboard.');
    return;
  }
  if (!vehicle.tankSize) {
    showError('Enter your tank size.');
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

    // Without a tracked fuel level or MPG, we assume a road-trip fuel stop is
    // close to a full fill regardless of which station is chosen — a
    // reasonable default since the point of stopping is to top off. This
    // keeps gallonsNeeded constant across candidates so price + detour are
    // what actually drive the ranking.
    const gallonsNeeded = vehicle.tankSize * FILL_TARGET_FRACTION;

    const candidates = stationsRes.stations
      .map((s) => {
        const priceInfo = priceByPlaceId[s.placeId];
        if (!priceInfo) return null;
        const detourMiles = (s.detourMeters ? milesFromMeters(s.detourMeters) : 0.6) * 2; // round trip off the route
        const assumedMpg = 25; // only used to price the small detour itself, not the fill-up
        const detourCost = (detourMiles / assumedMpg) * priceInfo.price;
        const totalCost = gallonsNeeded * priceInfo.price + detourCost;
        return { ...s, ...priceInfo, gallonsNeeded, totalCost, durationSeconds: s.durationSeconds };
      })
      .filter(Boolean)
      .sort((a, b) => a.totalCost - b.totalCost);

    setLoading('');

    if (candidates.length === 0) {
      renderNoStationsFound(isCriticallyLow);
      findBtn.disabled = false;
      return;
    }

    const best = candidates[0];
    const others = candidates.slice(1, 4);
    const avgOthersPrice = others.length
      ? others.reduce((sum, c) => sum + c.price, 0) / others.length
      : best.price;
    const savings = Math.max(0, (avgOthersPrice - best.price) * best.gallonsNeeded);

    renderResult(best, others, savings, isCriticallyLow);
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

function renderResult(best, others, savings, isCriticallyLow) {
  const conf = confidenceInfo(best.confidence);
  const area = document.getElementById('resultsArea');
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${best.lat},${best.lng}&query_place_id=${encodeURIComponent(best.placeId)}`;

  const altHtml = others.length
    ? `<div class="card" id="altCard" style="display:none;">
         <div class="card-title" style="font-size:14px;">Other reachable stops</div>
         <div class="alt-list">
           ${others.map((o) => `
             <div class="alt-item">
               <div>
                 <div class="alt-item-name">${escapeHtml(o.name)}</div>
                 <div class="alt-item-sub">${escapeHtml(o.address || '')}</div>
               </div>
               <div class="alt-item-price">${formatMoney(o.price)}/gal</div>
             </div>
           `).join('')}
         </div>
       </div>
       <div class="report-toggle" id="showAltToggle">See other reachable stops</div>`
    : '';

  area.innerHTML = `
    ${isCriticallyLow ? '<div class="notice">You’re low on fuel — this is the closest reachable stop, not necessarily the cheapest.</div>' : ''}
    <div class="result-card">
      <div class="result-eyebrow">Best stop for this trip</div>
      <div class="result-station">${escapeHtml(best.name)}</div>
      <div class="result-address">${escapeHtml(best.address || '')}</div>

      <div class="confidence-tag ${conf.cls}">${conf.label}</div>

      <div class="result-stats">
        <div class="result-stat-box">
          <div class="result-stat-label">Price</div>
          <div class="result-stat-value">${formatMoney(best.price)}/gal</div>
        </div>
        <div class="result-stat-box">
          <div class="result-stat-label">Est. savings</div>
          <div class="result-stat-value savings">${savings > 0.01 ? formatMoney(savings) : '—'}</div>
        </div>
      </div>

      <div class="result-stat-box" style="margin-bottom:16px;">
        <div class="result-stat-label">Time to stop</div>
        <div class="result-stat-value">${formatTimeFromNow(best.durationSeconds)}</div>
      </div>

      <div class="result-actions">
        <a class="btn btn-primary" href="${mapsUrl}" target="_blank" rel="noopener">Get Directions</a>
        <button class="btn btn-outline" id="findAgainBtn">Search Again</button>
      </div>

      <div class="report-toggle" id="showReportToggle">Price wrong? Report what you actually paid</div>
      <div class="report-form" id="reportForm">
        <input type="number" id="reportPrice" inputmode="decimal" placeholder="3.29" step="0.01" min="1" max="9">
        <button class="btn btn-primary btn-sm" id="submitReportBtn">Submit</button>
      </div>
    </div>
    ${altHtml}
  `;

  document.getElementById('findAgainBtn').addEventListener('click', () => {
    document.getElementById('resultsArea').innerHTML = '';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  const showAltToggle = document.getElementById('showAltToggle');
  if (showAltToggle) {
    showAltToggle.addEventListener('click', () => {
      const altCard = document.getElementById('altCard');
      altCard.style.display = altCard.style.display === 'none' ? 'block' : 'none';
    });
  }

  document.getElementById('showReportToggle').addEventListener('click', () => {
    document.getElementById('reportForm').classList.toggle('visible');
  });

  document.getElementById('submitReportBtn').addEventListener('click', async () => {
    const priceInput = document.getElementById('reportPrice');
    const price = parseFloat(priceInput.value);
    if (!price || price < 1 || price > 9) return;
    try {
      await postJson('/.netlify/functions/submit-price', {
        placeId: best.placeId,
        name: best.name,
        lat: best.lat,
        lng: best.lng,
        price,
      });
      document.getElementById('reportForm').innerHTML = '<div style="font-size:13px; color: var(--success);">Thanks — that helps other drivers.</div>';
    } catch (e) {}
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
