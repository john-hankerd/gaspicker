// netlify/functions/find-stations.js
// Given a list of points along a route (from get-route), searches Google's
// Places API (New) for gas stations near each point and returns a deduped
// list. Each station keeps the distance/duration of the route point it was
// found near (used as its "time to stop") and a rough detour distance
// (straight-line distance from the route to the station).
//
// Env var: GOOGLE_MAPS_SERVER_KEY (same key as get-route.js, must also have
// Places API (New) enabled).

const SEARCH_RADIUS_METERS = 3219; // ~2 miles
const MAX_SEARCH_POINTS = 8; // cap API calls on long reachable ranges

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function pickSearchPoints(points) {
  if (points.length <= MAX_SEARCH_POINTS) return points;
  const step = (points.length - 1) / (MAX_SEARCH_POINTS - 1);
  const picked = [];
  for (let i = 0; i < MAX_SEARCH_POINTS; i++) {
    picked.push(points[Math.round(i * step)]);
  }
  return picked;
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

  const points = Array.isArray(payload.points) ? payload.points : [];
  if (points.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No route points supplied.' }) };
  }

  const searchPoints = pickSearchPoints(points);
  const stationsByPlaceId = {};

  try {
    await Promise.all(
      searchPoints.map(async (point) => {
        const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': apiKey,
            'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location',
          },
          body: JSON.stringify({
            includedTypes: ['gas_station'],
            maxResultCount: 10,
            locationRestriction: {
              circle: {
                center: { latitude: point.lat, longitude: point.lng },
                radius: SEARCH_RADIUS_METERS,
              },
            },
          }),
        });

        if (!res.ok) return;
        const data = await res.json();
        if (!data.places) return;

        data.places.forEach((place) => {
          const placeId = place.id;
          if (!placeId || !place.location) return;
          const detourMeters = haversineMeters(point.lat, point.lng, place.location.latitude, place.location.longitude);

          const existing = stationsByPlaceId[placeId];
          if (existing && existing.distanceMeters <= point.distanceMeters) return;

          stationsByPlaceId[placeId] = {
            placeId,
            name: place.displayName?.text || 'Gas station',
            address: place.formattedAddress || '',
            lat: place.location.latitude,
            lng: place.location.longitude,
            distanceMeters: point.distanceMeters,
            durationSeconds: point.durationSeconds,
            detourMeters,
          };
        });
      })
    );

    return {
      statusCode: 200,
      body: JSON.stringify({ stations: Object.values(stationsByPlaceId) }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Station lookup is unavailable right now.' }) };
  }
};
