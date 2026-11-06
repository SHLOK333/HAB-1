// Great-circle helpers shared by the flight export, the predictor and the site.
const R = 6371008.8
const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI
export function haversine(a, b) {
  const dφ = rad(b.lat - a.lat), dλ = rad(b.lon - a.lon)
  const h = Math.sin(dφ / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dλ / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}
export function bearing(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat))
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon))
  return (deg(Math.atan2(y, x)) + 360) % 360
}
