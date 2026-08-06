// netlify/functions/submit-price.js
// Anonymous, no-login price reporting — this is what makes the crowd-sourced
// price data get better over time. No client ever touches Firestore
// directly; everything is validated and written server-side here.
//
// Basic abuse guard: one report per (ip hash + station) per hour. Not meant
// to be bulletproof, just enough friction to stop naive spam without
// requiring accounts.

const admin = require('firebase-admin');
const crypto = require('crypto');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)),
  });
}
const db = admin.firestore();

const RATE_LIMIT_MS = 60 * 60 * 1000;

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

  const { placeId, name, lat, lng, price } = payload;
  if (!placeId || typeof price !== 'number' || price < 1 || price > 9) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid price.' }) };
  }

  const ip = event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'] || 'unknown';
  const ipHash = crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
  const rateLimitId = `${ipHash}_${placeId}`;

  try {
    const rateLimitRef = db.collection('priceReportRateLimits').doc(rateLimitId);
    const rateLimitDoc = await rateLimitRef.get();
    if (rateLimitDoc.exists) {
      const lastAt = rateLimitDoc.data().at?.toMillis ? rateLimitDoc.data().at.toMillis() : 0;
      if (Date.now() - lastAt < RATE_LIMIT_MS) {
        return { statusCode: 200, body: JSON.stringify({ ok: true }) }; // silently accept, don't double-write
      }
    }

    const stationRef = db.collection('stationPrices').doc(placeId);
    await stationRef.set(
      {
        price,
        name: name || null,
        lat: typeof lat === 'number' ? lat : null,
        lng: typeof lng === 'number' ? lng : null,
        reportedAt: admin.firestore.FieldValue.serverTimestamp(),
        reportCount: admin.firestore.FieldValue.increment(1),
      },
      { merge: true }
    );

    await rateLimitRef.set({ at: admin.firestore.FieldValue.serverTimestamp() });

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Could not save your report right now.' }) };
  }
};
