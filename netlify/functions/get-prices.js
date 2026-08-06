// netlify/functions/get-prices.js
// Looks up crowd-sourced fuel prices for a list of stations. Prices are
// reported by drivers via submit-price.js and stored in Firestore
// (stationPrices/{placeId}). If no report exists yet, or it's stale, falls
// back to a flat estimate so the app still works from day one — this is the
// "free/low-cost to start" data source; a licensed price feed (GasBuddy/OPIS)
// can replace or supplement this fallback later without changing the client.
//
// Env vars: FIREBASE_SERVICE_ACCOUNT_KEY (Admin SDK creds, JSON string),
// FALLBACK_GAS_PRICE (optional, defaults to 3.25).

const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)),
  });
}
const db = admin.firestore();

const FALLBACK_PRICE = parseFloat(process.env.FALLBACK_GAS_PRICE) || 3.25;
const HIGH_CONFIDENCE_MS = 3 * 24 * 60 * 60 * 1000;   // reported within 3 days
const MEDIUM_CONFIDENCE_MS = 14 * 24 * 60 * 60 * 1000; // reported within 14 days

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Bad request.' }) };
  }

  const stations = Array.isArray(payload.stations) ? payload.stations : [];
  if (stations.length === 0) {
    return { statusCode: 200, body: JSON.stringify({ prices: [] }) };
  }

  try {
    const now = Date.now();
    const results = await Promise.all(
      stations.map(async (s) => {
        const doc = await db.collection('stationPrices').doc(s.placeId).get();
        if (!doc.exists) {
          return { placeId: s.placeId, price: FALLBACK_PRICE, confidence: 'low', reportedAt: null };
        }
        const data = doc.data();
        const reportedAt = data.reportedAt?.toMillis ? data.reportedAt.toMillis() : null;
        const age = reportedAt ? now - reportedAt : Infinity;
        const confidence = age <= HIGH_CONFIDENCE_MS ? 'high' : age <= MEDIUM_CONFIDENCE_MS ? 'medium' : 'low';
        const price = confidence === 'low' && age > MEDIUM_CONFIDENCE_MS ? FALLBACK_PRICE : data.price;
        return { placeId: s.placeId, price, confidence, reportedAt };
      })
    );

    return { statusCode: 200, body: JSON.stringify({ prices: results }) };
  } catch (err) {
    // Firestore unavailable — degrade to flat estimates rather than failing the whole trip.
    const results = stations.map((s) => ({ placeId: s.placeId, price: FALLBACK_PRICE, confidence: 'low', reportedAt: null }));
    return { statusCode: 200, body: JSON.stringify({ prices: results }) };
  }
};
