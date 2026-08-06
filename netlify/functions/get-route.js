// netlify/functions/get-route.js
// Server-side call to Google's Routes API (computeRoutes). Keeps the Maps API
// key off the client. Returns total distance/duration plus a series of
// sampled points along the route (roughly every 5 miles) so the client can
// figure out which of those points are within the driver's reachable range
// before searching for gas stations near them.
//
// Env var: GOOGLE_MAPS_SERVER_KEY (a Maps API key with Routes API enabled,
// NOT the browser-restricted key used for client-side maps elsewhere in the
// 40th Floor suite — this one should be unrestricted or IP-restricted, since
// it's only ever called from this server function).

const SAMPLE_INTERVAL_METERS = 8000; // ~5 miles between sample points

function decodePolyline(encoded) {
  let index = 0, lat = 0, lng = 0;
  const points = [];
  while (index < encoded.length) {
    let result = 1, shift = 0, b;
    do {
      b = encoded.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    result = 1; shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);

    points.push([lat * 1e-5, lng * 1e-5]);
  }
  return points;
}

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function sampleAlongRoute(points, totalDistanceMeters, totalDurationSeconds) {
  const samples = [{ lat: points[0][0], lng: points[0][1], distanceMeters: 0, durationSeconds: 0 }];
  let cumulative = 0;
  let nextTarget = SAMPLE_INTERVAL_METERS;

  for (let i = 1; i < points.length; i++) {
    const segMeters = haversineMeters(points[i - 1], points[i]);
    cumulative += segMeters;
    while (cumulative >= nextTarget && nextTarget < totalDistanceMeters) {
      const fraction = nextTarget / totalDistanceMeters;
      samples.push({
        lat: points[i][0],
        lng: points[i][1],
        distanceMeters: Math.round(nextTarget),
        durationSeconds: Math.round(fraction * totalDurationSeconds),
      });
      nextTarget += SAMPLE_INTERVAL_METERS;
    }
  }

  samples.push({
    lat: points[points.length - 1][0],
    lng: points[points.length - 1][1],
    distanceMeters: totalDistanceMeters,
    durationSeconds: totalDurationSeconds,
  });

  return samples;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.GOOGLE_MAPS_SERVER_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Server is not configured yet.' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Bad request.' }) };
  }

  const { origin, destination } = payload;
  if (!origin || typeof origin.lat !== 'number' || typeof origin.lng !== 'number' || !destination) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing origin or destination.' }) };
  }

  try {
    const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline',
      },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
        destination: { address: destination },
        travelMode: 'DRIVE',
        polylineQuality: 'OVERVIEW',
        units: 'IMPERIAL',
      }),
    });

    const data = await res.json();

    if (!res.ok || !data.routes || data.routes.length === 0) {
      const msg = data?.error?.message || 'Couldn’t find a route to that destination. Check the address and try again.';
      return { statusCode: 400, body: JSON.stringify({ error: msg }) };
    }

    const route = data.routes[0];
    const distanceMeters = route.distanceMeters;
    const durationSeconds = parseInt(String(route.duration).replace('s', ''), 10) || 0;
    const points = decodePolyline(route.polyline.encodedPolyline);
    const samples = sampleAlongRoute(points, distanceMeters, durationSeconds);

    return {
      statusCode: 200,
      body: JSON.stringify({ distanceMeters, durationSeconds, samples }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Routing service is unavailable right now.' }) };
  }
};
