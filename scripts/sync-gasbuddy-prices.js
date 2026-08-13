// scripts/sync-gasbuddy-prices.js
//
// One-off / manually-triggered sync that pulls real station prices from
// GasBuddy via a third-party Apify scraper (automation-lab/gasbuddy-fuel-
// prices-scraper — unaffiliated with GasBuddy, scrapes their public pages)
// and writes matched prices into the same Firestore stationPrices
// collection that get-prices.js reads and submit-price.js writes to.
//
// This is NOT a Netlify function — the scrape run alone regularly takes
// 30-200+ seconds, well past Netlify's synchronous function timeout, so it
// runs here as a plain Node script instead (manually for now; could later
// be wired into a scheduled task that isn't Netlify-hosted).
//
// Matching problem: the scraper doesn't return lat/lng, only a street
// address, so matches against our Google Places station list (which does
// have lat/lng) are done by normalized-address comparison: the leading
// street number must match exactly, plus at least one significant word
// in common (directionals and street-type suffixes are stripped before
// comparing, since "N" vs "North" / "St" vs "Street" formatting differs
// between Google and GasBuddy). This is scoped per search area, so the
// collision risk of a generic word like "Main" matching the wrong station
// is low in practice.
//
// Usage: node scripts/sync-gasbuddy-prices.js
// Requires env vars APIFY_API_TOKEN and FIREBASE_SERVICE_ACCOUNT_KEY (paths
// to files containing each, set below) to be available.

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const APIFY_TOKEN_FILE = process.env.APIFY_TOKEN_FILE;
const FIREBASE_KEY_FILE = process.env.FIREBASE_KEY_FILE;

if (!APIFY_TOKEN_FILE || !FIREBASE_KEY_FILE) {
  console.error('Set APIFY_TOKEN_FILE and FIREBASE_KEY_FILE env vars to file paths containing each secret.');
  process.exit(1);
}

const APIFY_TOKEN = fs.readFileSync(APIFY_TOKEN_FILE, 'utf8').trim();
const firebaseKey = JSON.parse(fs.readFileSync(FIREBASE_KEY_FILE, 'utf8'));

admin.initializeApp({ credential: admin.credential.cert(firebaseKey) });
const db = admin.firestore();

const SITE_BASE = 'https://gaspicker.netlify.app';
const APIFY_ACTOR = 'automation-lab~gasbuddy-fuel-prices-scraper';

const AREAS = [
  { name: 'Owosso, MI', lat: 42.9986, lng: -84.1738 },
  { name: 'Flint, MI', lat: 43.0125, lng: -83.6875 },
  { name: 'Lansing, MI', lat: 42.7325, lng: -84.5555 },
  { name: 'Durand, MI', lat: 42.9106, lng: -83.9866 },
  { name: 'Corunna, MI', lat: 42.9772, lng: -84.1197 },
];

function normalizeAddress(addr) {
  if (!addr) return '';
  let s = addr.toLowerCase();
  s = s.replace(/[.,]/g, ' ').replace(/-/g, ' ');
  s = s.replace(/\bnorth\b/g, 'n').replace(/\bsouth\b/g, 's').replace(/\beast\b/g, 'e').replace(/\bwest\b/g, 'w');
  s = s.replace(/\bstreet\b/g, 'st').replace(/\bavenue\b/g, 'ave').replace(/\broad\b/g, 'rd')
    .replace(/\bboulevard\b/g, 'blvd').replace(/\bdrive\b/g, 'dr').replace(/\blane\b/g, 'ln')
    .replace(/\bhighway\b/g, 'hwy').replace(/\bcircle\b/g, 'cir').replace(/\bcourt\b/g, 'ct')
    .replace(/\bplace\b/g, 'pl').replace(/\bparkway\b/g, 'pkwy');
  s = s.replace(/\bmi\s?(\d)/g, 'm$1');
  s = s.replace(/\bm\s(\d)/g, 'm$1');
  s = s.replace(/\b[nsew]\b/g, '');
  s = s.replace(/\b(st|ave|rd|blvd|dr|ln|hwy|cir|ct|pl|pkwy)\b/g, '');
  return s.replace(/\s+/g, ' ').trim();
}

function streetNumber(addr) {
  const m = (addr || '').match(/^\s*(\d+)/);
  return m ? m[1] : null;
}

function addressMatch(googleAddr, apifyAddr) {
  const gNum = streetNumber(googleAddr);
  const aNum = streetNumber(apifyAddr);
  if (!gNum || !aNum || gNum !== aNum) return false;
  const gWords = normalizeAddress(googleAddr).split(' ').filter((t) => t && t !== gNum && isNaN(t));
  const aWords = new Set(normalizeAddress(apifyAddr).split(' ').filter((t) => t && t !== aNum && isNaN(t)));
  return gWords.some((w) => aWords.has(w));
}

async function getGoogleStations(area) {
  const res = await fetch(`${SITE_BASE}/.netlify/functions/find-stations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ points: [{ lat: area.lat, lng: area.lng, distanceMeters: 0, durationSeconds: 0 }] }),
  });
  const data = await res.json();
  return data.stations || [];
}

async function runApifyScrape(areaName) {
  const res = await fetch(
    `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        searchQueries: [areaName],
        fuelGrade: 'regular_gas',
        maxResults: 60,
        proxyTier: 'AUTO',
      }),
    }
  );
  if (!res.ok) {
    console.error(`  Apify request failed: ${res.status} ${await res.text()}`);
    return [];
  }
  return res.json();
}

async function main() {
  let totalMatched = 0;
  let totalUnmatched = 0;

  for (const area of AREAS) {
    console.log(`\n=== ${area.name} ===`);
    const [googleStations, apifyRows] = await Promise.all([getGoogleStations(area), runApifyScrape(area.name)]);
    console.log(`  Google stations: ${googleStations.length}, GasBuddy rows: ${apifyRows.length}`);

    let matched = 0;
    for (const row of apifyRows) {
      const price = row.creditPrice ?? row.cashPrice;
      if (!price || price < 1 || price > 9) continue;

      const gStation = googleStations.find((g) => addressMatch(g.address, row.addressLine1));
      if (!gStation) continue;

      await db.collection('stationPrices').doc(gStation.placeId).set(
        {
          price,
          name: gStation.name,
          lat: gStation.lat,
          lng: gStation.lng,
          reportedAt: admin.firestore.FieldValue.serverTimestamp(),
          reportCount: admin.firestore.FieldValue.increment(1),
          source: 'gasbuddy_scrape',
        },
        { merge: true }
      );

      console.log(`  matched: ${gStation.name} @ ${gStation.address}  ->  $${price}`);
      matched++;
    }

    const unmatched = apifyRows.length - matched;
    console.log(`  matched ${matched}/${apifyRows.length} (${unmatched} unmatched)`);
    totalMatched += matched;
    totalUnmatched += unmatched;
  }

  console.log(`\nDone. Total matched: ${totalMatched}, unmatched: ${totalUnmatched}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
