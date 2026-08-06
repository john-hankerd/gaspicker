const RESERVE_FRACTION = 0.10;   // never plan to run below this fraction of the tank
const FILL_TARGET_FRACTION = 0.90; // plan to fill back up to this fraction, not a precise 100%
const METERS_PER_MILE = 1609.34;
const EMERGENCY_SEARCH_MILES = 10; // floor search radius when already below reserve

let vehicle = loadVehicleProfile();
let lastRouteResult = null;

function loadVehicleProfile() {
  try {
    const raw = localStorage.getItem('fs_vehicle');
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return { mpg: null, tankSize: null, fuelLevel: 0.5 };
}

function saveVehicleProfile() {
  localStorage.setItem('fs_vehicle', JSON.stringify(vehicle));
}

function initVehicleForm() {
  const mpgInput = document.getElementById('mpg');
  const tankInput = document.getElementById('tankSize');
  if (vehicle.mpg) mpgInput.value = vehicle.mpg;
  if (vehicle.tankSize) tankInput.value = vehicle.tankSize;

  mpgInput.addEventListener('change', () => {
    vehicle.mpg = parseFloat(mpgInput.value) || null;
    saveVehicleProfile();
  });
  tankInput.addEventListener('change', () => {
    vehicle.tankSize = parseFloat(tankInput.value) || null;
    saveVehicleProfile();
  });

  const presetBtns = document.querySelectorAll('.fuel-preset-btn');
  presetBtns.forEach((btn) => {
    const val = parseFloat(btn.dataset.val);
    if (Math.abs(val - (vehicle.fuelLevel ?? 0.5)) < 0.01) btn.classList.add('active');
    btn.addEventListener('click', () => {
      presetBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      vehicle.fuelLevel = val;
      saveVehicleProfile();
    });
  });

  const destInput = document.getElementById('destination');
  const savedDest = localStorage.getItem('fs_last_destination');
  if (savedDest) destInput.value = savedDest;
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
          reject(new Error('Location access was denied. Allow location for FuelStop in your browser settings, then try again.'));
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

  const mpgInput = document.getElementById('mpg');
  const tankInput = document.getElementById('tankSize');
  const destInput = document.getElementById('destination');

  vehicle.mpg = parseFloat(mpgInput.value) || null;
  vehicle.tankSize = parseFloat(tankInput.value) || null;
  saveVehicleProfile();

  if (!vehicle.mpg || !vehicle.tankSize) {
    showError('Enter your vehicle’s MPG and tank size first.');
    return;
  }
  if (!destInput.value.trim()) {
    showError('Enter where you’re headed.');
    return;
  }
  localStorage.setItem('fs_last_destination', destInput.value.trim());

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

    const fuelLevel = vehicle.fuelLevel ?? 0.5;
    const usableGallons = Math.max(0, fuelLevel * vehicle.tankSize - vehicle.tankSize * RESERVE_FRACTION);
    const comfortableMaxRangeMeters = usableGallons * vehicle.mpg * METERS_PER_MILE;
    const absoluteMaxRangeMeters = fuelLevel * vehicle.tankSize * vehicle.mpg * METERS_PER_MILE;
    const isCriticallyLow = comfortableMaxRangeMeters <= 0;

    if (!isCriticallyLow && comfortableMaxRangeMeters >= route.distanceMeters) {
      const gallonsAtArrival = usableGallons - (route.distanceMeters / METERS_PER_MILE) / vehicle.mpg;
      renderNoStopNeeded(gallonsAtArrival);
      setLoading('');
      findBtn.disabled = false;
      return;
    }

    const searchUpperBoundMeters = isCriticallyLow
      ? Math.min(absoluteMaxRangeMeters, EMERGENCY_SEARCH_MILES * METERS_PER_MILE, route.distanceMeters)
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

    const candidates = stationsRes.stations
      .map((s) => {
        const priceInfo = priceByPlaceId[s.placeId];
        if (!priceInfo) return null;
        const milesToStation = milesFromMeters(s.distanceMeters);
        const gallonsUsedToReach = milesToStation / vehicle.mpg;
        const gallonsRemainingAtStation = Math.max(0, fuelLevel * vehicle.tankSize - gallonsUsedToReach);
        const gallonsNeeded = Math.max(0, vehicle.tankSize * FILL_TARGET_FRACTION - gallonsRemainingAtStation);
        const detourMiles = (s.detourMeters ? milesFromMeters(s.detourMeters) : 0.6) * 2; // round trip off the route
        const detourCost = (detourMiles / vehicle.mpg) * priceInfo.price;
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

function renderNoStopNeeded(gallonsAtArrival) {
  const area = document.getElementById('resultsArea');
  area.innerHTML = `
    <div class="card notice notice-success" style="margin-bottom:16px;">
      <strong>You've got enough fuel to make it.</strong><br>
      You should arrive with roughly ${Math.max(0, gallonsAtArrival).toFixed(1)} gallons left — no stop needed for this trip.
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
