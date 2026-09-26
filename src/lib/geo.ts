/** Reference geo data for Indian cities (shared by the generator and the risk engine). */
export const CITIES = {
  Mumbai: { lat: 19.076, lng: 72.8777 },
  Delhi: { lat: 28.6139, lng: 77.209 },
  Bengaluru: { lat: 12.9716, lng: 77.5946 },
  Chennai: { lat: 13.0827, lng: 80.2707 },
  Hyderabad: { lat: 17.385, lng: 78.4867 },
  Pune: { lat: 18.5204, lng: 73.8567 },
  Kolkata: { lat: 22.5726, lng: 88.3639 },
  Ahmedabad: { lat: 23.0225, lng: 72.5714 },
  Jaipur: { lat: 26.9124, lng: 75.7873 },
  Lucknow: { lat: 26.8467, lng: 80.9462 },
  Kochi: { lat: 9.9312, lng: 76.2673 },
  Guwahati: { lat: 26.1445, lng: 91.7362 },
  Chandigarh: { lat: 30.7333, lng: 76.7794 },
  Bhubaneswar: { lat: 20.2961, lng: 85.8245 },
  Indore: { lat: 22.7196, lng: 75.8577 },
  Ranchi: { lat: 23.3441, lng: 85.3096 },
} as const;

export type CityName = keyof typeof CITIES;
export const CITY_NAMES = Object.keys(CITIES) as CityName[];

export function isKnownCity(city: string): city is CityName {
  return Object.prototype.hasOwnProperty.call(CITIES, city);
}

/** Great-circle distance in km. */
export function distanceKm(a: CityName, b: CityName): number {
  if (a === b) return 0;
  const R = 6371;
  const p = CITIES[a];
  const q = CITIES[b];
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(q.lat - p.lat);
  const dLng = toRad(q.lng - p.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(p.lat)) * Math.cos(toRad(q.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Implied travel speed between two events. Infinity if distance > 0 and no time elapsed. */
export function impliedSpeedKmh(a: CityName, b: CityName, elapsedMs: number): number {
  const km = distanceKm(a, b);
  if (km === 0) return 0;
  if (elapsedMs <= 0) return Number.POSITIVE_INFINITY;
  return km / (elapsedMs / 3_600_000);
}
