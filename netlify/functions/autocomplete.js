// netlify/functions/autocomplete.js
// Proxies Google's Places API (New) Autocomplete so the destination field can
// suggest addresses/cities as the driver types. Server-side only, same key
// as get-route.js / find-stations.js (GOOGLE_MAPS_SERVER_KEY).

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.GOOGLE_MAPS_SERVER_KEY;
  if (!apiKey) {
    return { statusCode: 200, body: JSON.stringify({ suggestions: [] }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Bad request.' }) };
  }

  const input = (payload.input || '').trim();
  if (input.length < 3) {
    return { statusCode: 200, body: JSON.stringify({ suggestions: [] }) };
  }

  const body = {
    input,
    includedRegionCodes: ['us'],
    sessionToken: payload.sessionToken || undefined,
  };

  if (payload.origin && typeof payload.origin.lat === 'number' && typeof payload.origin.lng === 'number') {
    body.locationBias = {
      circle: {
        center: { latitude: payload.origin.lat, longitude: payload.origin.lng },
        radius: 160000, // ~100 miles — bias, not a hard restriction
      },
    };
  }

  try {
    const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      return { statusCode: 200, body: JSON.stringify({ suggestions: [] }) };
    }

    const data = await res.json();
    const suggestions = (data.suggestions || [])
      .map((s) => s.placePrediction)
      .filter(Boolean)
      .map((p) => ({
        placeId: p.placeId,
        text: p.text?.text || '',
        mainText: p.structuredFormat?.mainText?.text || p.text?.text || '',
        secondaryText: p.structuredFormat?.secondaryText?.text || '',
      }));

    return { statusCode: 200, body: JSON.stringify({ suggestions }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ suggestions: [] }) };
  }
};
