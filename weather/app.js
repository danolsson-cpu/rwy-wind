"use strict";
/*
 * Weather — current position + search, with U.S. severe weather alerts,
 * air quality, pollen and the nearest wildfire.
 *
 * Data (all free, no account needed unless noted):
 *   Forecast + wind ...... Open-Meteo, built on national weather service models (NOAA HRRR/GFS in the U.S.)
 *   Severe weather ....... National Weather Service, api.weather.gov
 *   Place names (U.S.) ... National Weather Service /points
 *   Wildfires ............ NIFC / WFIGS current incident locations (federal interagency)
 *   Air quality .......... EPA AirNow (optional free key), otherwise Copernicus CAMS via Open-Meteo
 *   Pollen ............... Copernicus CAMS via Open-Meteo (Europe). No U.S. agency publishes pollen,
 *                          so U.S. pollen uses the Google Pollen API with a free key (Settings).
 *   Search ............... Open-Meteo geocoding (GeoNames), reverse names outside the U.S. from OpenStreetMap
 */

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const settings = Object.assign({ units: "auto", airnowKey: "", pollenKey: "" }, store.get("wx:settings", {}));
let saved = store.get("wx:saved", []);

function imperial() {
  if (settings.units === "us") return true;
  if (settings.units === "metric") return false;
  const l = (navigator.languages && navigator.languages[0]) || navigator.language || "en-US";
  return /-(US|LR|MM)\b/i.test(l) || l === "en";
}

/* ---------------- Network ---------------- */

async function fetchJSON(url, opts = {}, ms = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal });
    if (!res.ok) { const e = new Error("HTTP " + res.status); e.status = res.status; throw e; }
    return await res.json();
  } finally { clearTimeout(t); }
}

const URLS = {
  forecast: "https://api.open-meteo.com/v1/forecast",
  air: "https://air-quality-api.open-meteo.com/v1/air-quality",
  geocode: "https://geocoding-api.open-meteo.com/v1/search",
  nws: "https://api.weather.gov",
  wfigs: "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0/query",
  airnow: "https://www.airnowapi.org/aq/observation/latLong/current/",
  pollen: "https://pollen.googleapis.com/v1/forecast:lookup",
  nominatim: "https://nominatim.openstreetmap.org/reverse",
};
const NWS_HEADERS = { headers: { Accept: "application/geo+json" } };

const memo = new Map(); // short-lived cache so the list view and the main view share requests
function cached(key, ttl, fn) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.p;
  const p = fn().catch(e => { memo.delete(key); throw e; });
  memo.set(key, { t: Date.now(), p });
  return p;
}
const ll = p => p.lat.toFixed(3) + "," + p.lon.toFixed(3);

function getForecast(place) {
  const imp = imperial();
  return cached("fc:" + ll(place) + imp, 10 * 60e3, () => {
    const q = new URLSearchParams({
      latitude: place.lat.toFixed(4), longitude: place.lon.toFixed(4), timezone: "auto", forecast_days: "10",
      current: "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,visibility,uv_index,dew_point_2m",
      hourly: "temperature_2m,weather_code,precipitation_probability,is_day",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,sunrise,sunset,uv_index_max",
      wind_speed_unit: imp ? "mph" : "kmh",
    });
    if (imp) { q.set("temperature_unit", "fahrenheit"); q.set("precipitation_unit", "inch"); }
    return fetchJSON(URLS.forecast + "?" + q).then(f => (f.imperial = imp, f));
  });
}

// U.S. check + place name from the National Weather Service. Rejects outside NWS coverage.
function getNwsPoint(place) {
  return cached("pt:" + ll(place), 24 * 3600e3, () =>
    fetchJSON(`${URLS.nws}/points/${place.lat.toFixed(4)},${place.lon.toFixed(4)}`, NWS_HEADERS));
}

function getAlerts(place) {
  return cached("al:" + ll(place), 3 * 60e3, () =>
    fetchJSON(`${URLS.nws}/alerts/active?point=${place.lat.toFixed(4)},${place.lon.toFixed(4)}`, NWS_HEADERS)
      .then(j => (j.features || []).map(f => f.properties)));
}

async function reverseName(place) {
  try {
    const pt = await getNwsPoint(place);
    const rl = pt.properties && pt.properties.relativeLocation && pt.properties.relativeLocation.properties;
    if (rl && rl.city) return { name: rl.city, admin: rl.state || "", cc: "US" };
  } catch { /* not in the U.S. (or NWS down) */ }
  const q = new URLSearchParams({ format: "jsonv2", lat: place.lat, lon: place.lon, zoom: "10", "accept-language": "en" });
  const j = await fetchJSON(URLS.nominatim + "?" + q);
  const a = j.address || {};
  return { name: a.city || a.town || a.village || a.hamlet || a.municipality || a.county || j.name || "My Location", admin: a.state || "", country: a.country || "", cc: (a.country_code || "").toUpperCase() };
}

// Copernicus CAMS air quality + pollen (pollen only populated in Europe).
const POLLEN_VARS = ["alder_pollen", "birch_pollen", "olive_pollen", "grass_pollen", "mugwort_pollen", "ragweed_pollen"];
function getCams(place) {
  return cached("aq:" + ll(place), 20 * 60e3, async () => {
    const base = "us_aqi,us_aqi_pm2_5,us_aqi_pm10,us_aqi_ozone,us_aqi_nitrogen_dioxide,us_aqi_sulphur_dioxide,us_aqi_carbon_monoxide,pm2_5,pm10,ozone,nitrogen_dioxide,sulphur_dioxide,carbon_monoxide";
    const q = new URLSearchParams({ latitude: place.lat.toFixed(4), longitude: place.lon.toFixed(4), timezone: "auto", current: base + "," + POLLEN_VARS.join(",") });
    try { return await fetchJSON(URLS.air + "?" + q); }
    catch (e) { q.set("current", base); return fetchJSON(URLS.air + "?" + q); }
  });
}

// EPA AirNow (official U.S. AQI). Needs a free key from docs.airnowapi.org.
function getAirNow(place) {
  return cached("an:" + ll(place), 20 * 60e3, async () => {
    const q = new URLSearchParams({ format: "application/json", latitude: place.lat.toFixed(4), longitude: place.lon.toFixed(4), distance: "50", API_KEY: settings.airnowKey });
    const rows = await fetchJSON(URLS.airnow + "?" + q);
    if (!Array.isArray(rows) || !rows.length) throw new Error("No AirNow reporting area nearby");
    return rows;
  });
}

function getGooglePollen(place) {
  return cached("gp:" + ll(place), 60 * 60e3, () => {
    const q = new URLSearchParams({ key: settings.pollenKey, "location.latitude": place.lat.toFixed(4), "location.longitude": place.lon.toFixed(4), days: "1", languageCode: "en", plantsDescription: "false" });
    return fetchJSON(URLS.pollen + "?" + q);
  });
}

// All current wildfire incidents (WF = wildfire, skips prescribed burns), from NIFC's WFIGS service.
function getFires() {
  return cached("fires", 15 * 60e3, async () => {
    const fields = "IncidentName,IncidentSize,PercentContained,FireDiscoveryDateTime,POOState,POOCounty,IncidentTypeCategory,UniqueFireIdentifier";
    let where = "IncidentTypeCategory='WF'", outFields = fields;
    const out = [];
    for (let page = 0, offset = 0; page < 10; page++) {
      const q = new URLSearchParams({ where, outFields, returnGeometry: "true", outSR: "4326", f: "json", resultOffset: String(offset), resultRecordCount: "2000" });
      const j = await fetchJSON(URLS.wfigs + "?" + q, {}, 25000);
      if (j.error) {
        if (where !== "1=1") { where = "1=1"; outFields = "*"; page = -1; offset = 0; out.length = 0; continue; }
        throw new Error(j.error.message || "Wildfire service error");
      }
      for (const f of j.features || []) {
        const a = f.attributes || {}, g = f.geometry;
        if (!g || !isFinite(g.x) || !isFinite(g.y)) continue;
        if (a.IncidentTypeCategory && a.IncidentTypeCategory !== "WF") continue;
        out.push({
          name: titleCase(a.IncidentName || "Unnamed fire"), acres: a.IncidentSize, contained: a.PercentContained,
          discovered: a.FireDiscoveryDateTime, state: (a.POOState || "").replace(/^US-/, ""), county: a.POOCounty || "",
          lat: g.y, lon: g.x,
        });
      }
      const n = (j.features || []).length;
      if (!j.exceededTransferLimit || !n) break;
      offset += n;
    }
    return out;
  });
}

async function geocode(text) {
  const raw = text.trim();
  const zip = /^\d{5}$/.test(raw);
  const [name, ...rest] = raw.split(",").map(s => s.trim());
  const q = new URLSearchParams({ name: zip ? raw : name, count: "25", language: "en", format: "json" });
  if (zip) q.set("countryCode", "US");
  const j = await fetchJSON(URLS.geocode + "?" + q);
  let r = j.results || [];
  const hint = rest.join(" ").toLowerCase();
  if (hint) {
    const f = r.filter(x => [x.admin1, x.country, x.country_code, STATES[x.admin1]].some(v => v && v.toLowerCase().startsWith(hint)));
    if (f.length) r = f;
  }
  return r.slice(0, 12).map(x => ({ name: x.name, admin: x.admin1 || "", country: x.country || "", cc: (x.country_code || "").toUpperCase(), lat: x.latitude, lon: x.longitude }));
}

/* ---------------- Helpers ---------------- */

const STATES = { Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA", Colorado: "CO", Connecticut: "CT", Delaware: "DE", "District of Columbia": "DC", Florida: "FL", Georgia: "GA", Hawaii: "HI", Idaho: "ID", Illinois: "IL", Indiana: "IN", Iowa: "IA", Kansas: "KS", Kentucky: "KY", Louisiana: "LA", Maine: "ME", Maryland: "MD", Massachusetts: "MA", Michigan: "MI", Minnesota: "MN", Mississippi: "MS", Missouri: "MO", Montana: "MT", Nebraska: "NE", Nevada: "NV", "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY", "North Carolina": "NC", "North Dakota": "ND", Ohio: "OH", Oklahoma: "OK", Oregon: "OR", Pennsylvania: "PA", "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD", Tennessee: "TN", Texas: "TX", Utah: "UT", Vermont: "VT", Virginia: "VA", Washington: "WA", "West Virginia": "WV", Wisconsin: "WI", Wyoming: "WY", "Puerto Rico": "PR" };
const US_CODES = new Set(["US", "PR", "GU", "VI", "AS", "MP"]);
const isUS = p => US_CODES.has(p.cc);

function titleCase(s) { return String(s).toLowerCase().replace(/\b([a-z])/g, m => m.toUpperCase()); }
const DIRS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const DIR_WORDS = { N: "north", NNE: "north-northeast", NE: "northeast", ENE: "east-northeast", E: "east", ESE: "east-southeast", SE: "southeast", SSE: "south-southeast", S: "south", SSW: "south-southwest", SW: "southwest", WSW: "west-southwest", W: "west", WNW: "west-northwest", NW: "northwest", NNW: "north-northwest" };
const compass = deg => DIRS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
const deg2rad = d => d * Math.PI / 180;

function distanceMiles(a, b) {
  const R = 3958.8, dLat = deg2rad(b.lat - a.lat), dLon = deg2rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(deg2rad(a.lat)) * Math.cos(deg2rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
function bearing(a, b) {
  const y = Math.sin(deg2rad(b.lon - a.lon)) * Math.cos(deg2rad(b.lat));
  const x = Math.cos(deg2rad(a.lat)) * Math.sin(deg2rad(b.lat)) - Math.sin(deg2rad(a.lat)) * Math.cos(deg2rad(b.lat)) * Math.cos(deg2rad(b.lon - a.lon));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

const T = v => (v == null || isNaN(v)) ? "--" : Math.round(v) + "°";
const num = (v, d = 0) => (v == null || isNaN(v)) ? "--" : Number(v).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
// Open-Meteo returns local wall-clock times like "2026-10-13T06:58" for the place's time zone.
function clock(s, short) {
  const h = +s.slice(11, 13), m = s.slice(14, 16), h12 = (h % 12) || 12, ap = h < 12 ? "AM" : "PM";
  return short ? h12 + ap : `${h12}:${m} ${ap}`;
}
const weekday = s => new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10))).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
function zoned(iso, tz) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: tz || undefined }); }
  catch { return new Date(iso).toLocaleString(); }
}

/* ---------------- Weather codes & icons ---------------- */

const WMO = {
  0: ["Clear", "clear"], 1: ["Mostly Clear", "clear"], 2: ["Partly Cloudy", "partly"], 3: ["Cloudy", "cloudy"],
  45: ["Fog", "fog"], 48: ["Freezing Fog", "fog"],
  51: ["Light Drizzle", "drizzle"], 53: ["Drizzle", "drizzle"], 55: ["Heavy Drizzle", "drizzle"], 56: ["Freezing Drizzle", "sleet"], 57: ["Freezing Drizzle", "sleet"],
  61: ["Light Rain", "rain"], 63: ["Rain", "rain"], 65: ["Heavy Rain", "heavyrain"], 66: ["Freezing Rain", "sleet"], 67: ["Freezing Rain", "sleet"],
  71: ["Light Snow", "snow"], 73: ["Snow", "snow"], 75: ["Heavy Snow", "snow"], 77: ["Snow Grains", "snow"],
  80: ["Rain Showers", "rain"], 81: ["Rain Showers", "rain"], 82: ["Heavy Showers", "heavyrain"], 85: ["Snow Showers", "snow"], 86: ["Snow Showers", "snow"],
  95: ["Thunderstorms", "storm"], 96: ["Thunderstorms, Hail", "storm"], 99: ["Thunderstorms, Hail", "storm"],
};
const wmo = c => WMO[c] || ["—", "cloudy"];
function condName(code, isDay) {
  const n = wmo(code)[0];
  if (isDay && code <= 1) return code === 0 ? "Sunny" : "Mostly Sunny";
  return n;
}
function skyFor(code, isDay) {
  const k = wmo(code)[1];
  if (k === "storm") return "storm";
  if (k === "snow" || k === "sleet") return "snow";
  if (k === "fog") return "fog";
  if (k === "rain" || k === "heavyrain" || k === "drizzle") return isDay ? "rain-day" : "rain-night";
  if (k === "cloudy") return isDay ? "cloudy-day" : "cloudy-night";
  return isDay ? "clear-day" : "clear-night";
}
const SKY_COLORS = {
  "clear-day": ["#2a78d6", "#7fb8ee"], "clear-night": ["#070d22", "#23315c"], "cloudy-day": ["#5b748d", "#9cb0c3"], "cloudy-night": ["#151b25", "#384353"],
  "rain-day": ["#3f4e5f", "#6e8193"], "rain-night": ["#0f141c", "#2c3644"], storm: ["#1d1f33", "#4a4c6c"], snow: ["#6f87a3", "#b9c9da"], fog: ["#79838e", "#b2b9c1"],
};

// Multicolor icons in the spirit of SF Symbols' weather set.
const CLOUD = "M9.5 27.5h17a6 6 0 0 0 .8-11.95 8 8 0 0 0-15.4-1.55A6.75 6.75 0 0 0 9.5 27.5z";
const sunG = (cx, cy, r) => {
  let rays = "";
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4, r1 = r + 2.6, r2 = r + 5.2;
    rays += `M${(cx + r1 * Math.cos(a)).toFixed(2)} ${(cy + r1 * Math.sin(a)).toFixed(2)}L${(cx + r2 * Math.cos(a)).toFixed(2)} ${(cy + r2 * Math.sin(a)).toFixed(2)}`;
  }
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#FFD60A"/><path d="${rays}" stroke="#FFD60A" stroke-width="2.2" stroke-linecap="round"/>`;
};
const moonG = (tx = 0, ty = 0, s = 1) => `<path transform="translate(${tx} ${ty}) scale(${s})" d="M21 5.5a11 11 0 1 0 9.5 16.4A9 9 0 0 1 21 5.5z" fill="#F2F2F7"/>`;
const cloudG = (fill = "#fff", tf = "") => `<path d="${CLOUD}" fill="${fill}" ${tf ? `transform="${tf}"` : ""}/>`;
const drops = (n, color = "#4FC3F7") => {
  const xs = n === 2 ? [13, 21] : [11, 17.5, 24];
  return xs.map(x => `<path d="M${x} 28.5l-1.6 4.5" stroke="${color}" stroke-width="2.4" stroke-linecap="round"/>`).join("");
};
function icon(code, isDay = 1) {
  const k = wmo(code)[1];
  const up = "translate(0 -4)";
  let g;
  switch (k) {
    case "clear": g = isDay ? sunG(18, 18, 7) : moonG(-2, -1, 1.05); break;
    case "partly": g = (isDay ? sunG(13, 12, 5) : moonG(-6, -5, .75)) + cloudG("#fff", "translate(3 3) scale(.92)"); break;
    case "cloudy": g = cloudG("#D8DCE3", "translate(-3 -4) scale(.9)") + cloudG("#fff", "translate(3 2) scale(.92)"); break;
    case "fog": g = cloudG("#E5E7EB", up) + `<path d="M7 28h22M10 32h16" stroke="#E5E7EB" stroke-width="2.2" stroke-linecap="round"/>`; break;
    case "drizzle": g = cloudG("#fff", up) + drops(2, "#7FD3FF"); break;
    case "rain": g = cloudG("#fff", up) + drops(3); break;
    case "heavyrain": g = cloudG("#D8DCE3", up) + drops(3, "#2FA8F0") + `<path d="M14 26.5l-1.6 4.5M20.5 26.5l-1.6 4.5" stroke="#2FA8F0" stroke-width="2.4" stroke-linecap="round" transform="translate(0 2)"/>`; break;
    case "sleet": g = cloudG("#fff", up) + `<path d="M12 28.5l-1.5 4.2" stroke="#4FC3F7" stroke-width="2.3" stroke-linecap="round"/><circle cx="18" cy="30.5" r="1.6" fill="#fff"/><path d="M24 28.5l-1.5 4.2" stroke="#4FC3F7" stroke-width="2.3" stroke-linecap="round"/>`; break;
    case "snow": g = cloudG("#fff", up) + [11, 18, 25].map((x, i) => `<circle cx="${x}" cy="${i === 1 ? 32 : 29.5}" r="1.9" fill="#fff"/>`).join(""); break;
    case "storm": g = cloudG("#C9CDD6", up) + `<path d="M19 23l-4.5 7h4l-2 5.5 6.5-8h-4.2l2.2-4.5z" fill="#FFD60A"/>` + `<path d="M11 28.5l-1.4 4M27 28.5l-1.4 4" stroke="#4FC3F7" stroke-width="2.2" stroke-linecap="round"/>`; break;
    default: g = cloudG("#fff");
  }
  return `<svg viewBox="0 0 36 36" aria-hidden="true">${g}</svg>`;
}

// Small line glyphs for card headers and buttons.
const G = {
  wind: "M3 8h10a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h7",
  aqi: "M3 6h10M3 10h18M3 14h14M3 18h8",
  leaf: "M5 20c0-9 6-15 16-15 0 10-6 15-15 15M5 20l8-8",
  flame: "M12 2.5c.8 4 6 6 6 11.5a6 6 0 0 1-12 0c0-3 2-4.5 2-7 2 1.2 3 3.5 3 3.5 1-3 1-5 1-8z",
  alert: "M12 3.5l9.5 17h-19zM12 10v5M12 17.6v.4",
  sun: "M12 7.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  thermo: "M10 14V5a2 2 0 1 1 4 0v9a4 4 0 1 1-4 0z",
  drop: "M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z",
  gauge: "M3.5 17a9 9 0 1 1 17 0M12 13l4.5-4.5",
  sunrise: "M3 19h18M6 19a6 6 0 0 1 12 0M12 3v6M9 6l3-3 3 3",
  umbrella: "M3 12a9 9 0 0 1 18 0zM12 12v7a2 2 0 0 1-4 0",
  clock: "M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 7v5l3 2",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v5M16 3v5",
  loc: "M20.5 3.5L3.5 11l7 2.5 2.5 7z",
  search: "M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM15.5 15.5L21 21",
  list: "M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01",
  x: "M6 6l12 12M18 6L6 18",
  more: "M5.5 12h.01M12 12h.01M18.5 12h.01",
  chev: "M9 5l7 7-7 7",
  check: "M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM8 12.5l2.8 2.8L16.5 9.5",
  arrow: "M12 3v18M12 3l-6 6M12 3l6 6",
};
const glyph = (k, w = 2) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${G[k]}"/></svg>`;
const locFill = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${G.loc}" fill="currentColor"/></svg>`;

/* ---------------- Cards ---------------- */

function card(id, { title, glyphKey, body, cls = "", action = "" }) {
  const el = $("#" + id);
  if (!el) return;
  const tag = action ? "button" : "section";
  el.innerHTML = `<${tag} class="card ${cls}" ${action ? `type="button" data-action="${action}"` : ""}>
    ${title ? `<h2 class="card-h">${glyph(glyphKey)}<span>${esc(title)}</span>${action ? glyph("chev", 2.5).replace("<svg", '<svg class="chev"') : ""}</h2>` : ""}
    ${body}</${tag}>`;
}
const clear = (...ids) => ids.forEach(id => { const el = $("#" + id); if (el) el.innerHTML = ""; });
const loadingCard = (id, title, g) => card(id, { title, glyphKey: g, body: `<div class="loading">Loading</div>` });
const errorCard = (id, title, g, msg) => card(id, { title, glyphKey: g, body: `<div class="card-note">${esc(msg)}</div>` });

/* ---------------- Rendering: forecast ---------------- */

const tempColor = f => {
  const stops = [[10, [94, 92, 230]], [32, [90, 200, 250]], [50, [100, 210, 180]], [65, [52, 199, 89]], [75, [255, 214, 10]], [88, [255, 159, 10]], [100, [255, 69, 58]]];
  if (f <= stops[0][0]) return `rgb(${stops[0][1]})`;
  for (let i = 1; i < stops.length; i++) {
    if (f <= stops[i][0]) {
      const [a, ca] = stops[i - 1], [b, cb] = stops[i], t = (f - a) / (b - a);
      return `rgb(${ca.map((c, j) => Math.round(c + (cb[j] - c) * t))})`;
    }
  }
  return `rgb(${stops[stops.length - 1][1]})`;
};

function renderForecast(f, place) {
  const c = f.current, d = f.daily, h = f.hourly, imp = f.imperial;
  const toF = v => imp ? v : v * 9 / 5 + 32;
  const sky = skyFor(c.weather_code, c.is_day);
  document.body.dataset.sky = sky;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = SKY_COLORS[sky][0];

  $("#h-temp").textContent = T(c.temperature_2m);
  $("#h-cond").textContent = condName(c.weather_code, c.is_day);
  $("#h-hl").textContent = `H:${T(d.temperature_2m_max[0])}  L:${T(d.temperature_2m_min[0])}`;
  $("#mini-line").textContent = `${T(c.temperature_2m)} ${condName(c.weather_code, c.is_day)}`;

  // Hourly: next 24 hours with sunrise/sunset slotted in.
  const nowKey = c.time.slice(0, 13) + ":00";
  let start = h.time.findIndex(t => t >= nowKey);
  if (start < 0) start = 0;
  const items = [];
  for (let i = start; i < Math.min(h.time.length, start + 25); i++) items.push({ t: h.time[i], i });
  const end = items.length ? items[items.length - 1].t : nowKey;
  for (let k = 0; k < d.time.length; k++) {
    for (const [key, label] of [["sunrise", "Sunrise"], ["sunset", "Sunset"]]) {
      const s = d[key][k];
      if (s && s > c.time && s < end) items.push({ t: s, sun: label });
    }
  }
  items.sort((a, b) => a.t < b.t ? -1 : a.t > b.t ? 1 : (a.sun ? 1 : -1));
  const hours = items.map((it, n) => {
    if (it.sun) return `<div class="hour sun"><div class="t">${clock(it.t)}</div><div class="ico">${sunEventIcon(it.sun)}</div><div class="v">${it.sun}</div></div>`;
    const p = h.precipitation_probability ? h.precipitation_probability[it.i] : null;
    return `<div class="hour"><div class="t">${n === 0 ? "Now" : clock(it.t, true)}</div>
      <div class="ico">${icon(h.weather_code[it.i], h.is_day[it.i])}${p >= 20 ? `<div class="p">${Math.round(p / 10) * 10}%</div>` : ""}</div>
      <div class="v">${n === 0 ? T(c.temperature_2m) : T(h.temperature_2m[it.i])}</div></div>`;
  }).join("");
  card("c-hourly", { body: `<div class="card-text">${esc(hourlySummary(f))}</div><hr class="rule"><div class="hourly">${hours}</div>` });

  // 10-day with temperature range bars.
  const lo = Math.min(...d.temperature_2m_min), hi = Math.max(...d.temperature_2m_max), span = Math.max(1, hi - lo);
  const rows = d.time.map((day, i) => {
    const a = d.temperature_2m_min[i], b = d.temperature_2m_max[i], p = d.precipitation_probability_max ? d.precipitation_probability_max[i] : null;
    const left = (a - lo) / span * 100, width = Math.max(4, (b - a) / span * 100);
    const now = i === 0 ? `<i class="now" style="left:${Math.min(100, Math.max(0, (c.temperature_2m - lo) / span * 100)).toFixed(1)}%"></i>` : "";
    return `<div class="day"><span class="d">${i === 0 ? "Today" : weekday(day)}</span>
      <span class="ico">${icon(d.weather_code[i], 1)}${p >= 20 ? `<span class="p">${Math.round(p / 10) * 10}%</span>` : ""}</span>
      <span class="lo">${T(a)}</span>
      <span class="track"><i class="fill" style="left:${left.toFixed(1)}%;width:${width.toFixed(1)}%;background:linear-gradient(90deg,${tempColor(toF(a))},${tempColor(toF(b))})"></i>${now}</span>
      <span>${T(b)}</span></div>`;
  }).join("");
  card("c-daily", { title: `${d.time.length}-Day Forecast`, glyphKey: "calendar", body: rows });

  // Wind
  const spd = imp ? "mph" : "km/h";
  const wd = c.wind_direction_10m, ws = c.wind_speed_10m, wg = c.wind_gusts_10m;
  card("c-wind", {
    title: "Wind", glyphKey: "wind",
    body: `<div class="wind"><div>
        <div class="wrow"><span>Wind</span><b>${num(ws)} ${spd}</b></div>
        <div class="wrow"><span>Gusts</span><b>${num(wg)} ${spd}</b></div>
        <div class="wrow"><span>Direction</span><b>${num(wd)}° ${compass(wd)}</b></div>
      </div>${compassSVG(wd, ws, spd)}</div>
      <div class="card-note">${ws < 1 ? "Calm right now." : `Wind from the ${DIR_WORDS[compass(wd)]}${wg > ws * 1.4 && wg > (imp ? 15 : 25) ? `, gusting to ${num(wg)} ${spd}` : ""}.`}</div>`,
  });

  // Small squares
  const uv = c.uv_index ?? 0, uvMax = d.uv_index_max ? d.uv_index_max[0] : null;
  card("c-uv", { title: "UV Index", glyphKey: "sun", cls: "square", body: `<div class="big">${num(uv)}</div><div class="sub">${uvLevel(uv)}</div>
    <div class="scale uv"><i class="dot" style="left:${Math.min(100, uv / 11 * 100).toFixed(1)}%"></i></div>
    <div class="card-note">${uvMax != null ? `Today's high: ${num(uvMax)}, ${uvLevel(uvMax).toLowerCase()}.` : ""}</div>` });

  const feel = c.apparent_temperature, diff = feel - c.temperature_2m;
  card("c-feels", { title: "Feels Like", glyphKey: "thermo", cls: "square", body: `<div class="big">${T(feel)}</div>
    <div class="card-note">${Math.abs(diff) < (imp ? 3 : 2) ? "Similar to the actual temperature." : diff < 0 ? (ws > 5 ? "Wind is making it feel colder." : "Feels colder than the actual temperature.") : "Humidity is making it feel warmer."}</div>` });

  card("c-humid", { title: "Humidity", glyphKey: "drop", cls: "square", body: `<div class="big">${num(c.relative_humidity_2m)}%</div>
    <div class="card-note">The dew point is ${T(c.dew_point_2m)} right now.</div>` });

  const visUnit = (f.current_units && f.current_units.visibility) || "m";
  const visM = visUnit.startsWith("ft") ? c.visibility * 0.3048 : c.visibility;
  const vis = imp ? visM / 1609.344 : visM / 1000;
  card("c-vis", { title: "Visibility", glyphKey: "eye", cls: "square", body: `<div class="big">${vis >= 10 ? num(vis) : num(vis, 1)}<small>${imp ? "mi" : "km"}</small></div>
    <div class="card-note">${vis >= (imp ? 6 : 10) ? "Perfectly clear view." : vis >= (imp ? 3 : 5) ? "Slightly hazy." : vis >= 1 ? "Reduced visibility." : "Very low visibility."}</div>` });

  const hpa = c.pressure_msl;
  card("c-press", { title: "Pressure", glyphKey: "gauge", cls: "square", body: imp
    ? `<div class="big">${num(hpa * 0.02953, 2)}<small>inHg</small></div><div class="card-note">${num(hpa)} hPa at sea level.</div>`
    : `<div class="big">${num(hpa)}<small>hPa</small></div><div class="card-note">At sea level.</div>` });

  const nextRise = d.sunrise.find(s => s > c.time), nextSet = d.sunset.find(s => s > c.time);
  const sunUp = c.is_day;
  card("c-sun", { title: sunUp ? "Sunset" : "Sunrise", glyphKey: "sunrise", cls: "square", body: `<div class="big">${(sunUp ? nextSet : nextRise) ? clock(sunUp ? nextSet : nextRise) : "--"}</div>
    <div class="card-note">${sunUp ? (nextRise ? "Sunrise: " + clock(nextRise) : "") : (nextSet ? "Sunset: " + clock(nextSet) : "")}</div>` });

  const pu = imp ? "″" : " mm", ps = d.precipitation_sum || [];
  const nextWet = ps.findIndex((v, i) => i > 0 && v > (imp ? 0.01 : 0.2));
  card("c-precip", { title: "Precipitation", glyphKey: "umbrella", cls: "square", body: `<div class="big">${num(ps[0], imp ? 2 : 1)}${pu}</div><div class="sub">Today</div>
    <div class="card-note">${nextWet > 0 ? `${num(ps[nextWet], imp ? 2 : 1)}${pu} expected ${nextWet === 1 ? "tomorrow" : weekday(d.time[nextWet])}.` : "None expected in the next 10 days."}</div>` });

  state.tz = f.timezone;
}

function sunEventIcon(which) {
  const up = which === "Sunrise";
  return `<svg viewBox="0 0 36 36" aria-hidden="true"><path d="M8 27a10 10 0 0 1 20 0z" fill="#FFD60A"/><path d="M4 28h28" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>
    <path d="${up ? "M18 5v7M14.5 8.5L18 5l3.5 3.5" : "M18 5v7M14.5 8.5L18 12l3.5-3.5"}" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function hourlySummary(f) {
  const h = f.hourly, c = f.current;
  const start = Math.max(0, h.time.findIndex(t => t >= c.time.slice(0, 13) + ":00"));
  const pp = h.precipitation_probability || [];
  for (let i = start; i < Math.min(h.time.length, start + 12); i++) {
    if (pp[i] >= 50) {
      const k = wmo(h.weather_code[i])[1];
      const what = k === "snow" ? "Snow" : k === "storm" ? "Thunderstorms" : "Rain";
      return i === start ? `${what} likely right now. Wind gusts up to ${num(Math.max(c.wind_gusts_10m || 0))} ${f.imperial ? "mph" : "km/h"}.` : `${what} likely around ${clock(h.time[i], true)}.`;
    }
  }
  const later = h.weather_code[start + 6];
  const cond = condName(later ?? c.weather_code, h.is_day[start + 6] ?? c.is_day).toLowerCase();
  return `${condName(c.weather_code, c.is_day)} now, ${cond} conditions expected later. Wind gusts are up to ${num(c.wind_gusts_10m)} ${f.imperial ? "mph" : "km/h"}.`;
}

const uvLevel = v => v < 3 ? "Low" : v < 6 ? "Moderate" : v < 8 ? "High" : v < 11 ? "Very High" : "Extreme";

function compassSVG(dir, speed, unit) {
  let ticks = "";
  for (let i = 0; i < 72; i++) {
    const a = i * 5 * Math.PI / 180, major = i % 18 === 0, r1 = major ? 50 : (i % 6 === 0 ? 52 : 54), r2 = 58;
    ticks += `<line x1="${(66 + r1 * Math.sin(a)).toFixed(1)}" y1="${(66 - r1 * Math.cos(a)).toFixed(1)}" x2="${(66 + r2 * Math.sin(a)).toFixed(1)}" y2="${(66 - r2 * Math.cos(a)).toFixed(1)}" stroke="rgba(255,255,255,${major ? .9 : .35})" stroke-width="${major ? 2 : 1}"/>`;
  }
  const lbl = (t, x, y) => `<text x="${x}" y="${y}" fill="rgba(255,255,255,.8)" font-size="11" font-weight="700" text-anchor="middle" dominant-baseline="central">${t}</text>`;
  // Arrow drawn pointing where the wind is blowing to (from `dir`), like the Weather app.
  const arrow = isFinite(dir) && speed >= 1 ? `<g transform="rotate(${(dir + 180) % 360} 66 66)">
      <line x1="66" y1="118" x2="66" y2="20" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
      <path d="M66 12l-7 12h14z" fill="#fff"/><circle cx="66" cy="118" r="4" fill="none" stroke="#fff" stroke-width="2.5"/></g>` : "";
  return `<svg class="compass" viewBox="0 0 132 132" aria-label="Wind direction ${Math.round(dir)} degrees">${ticks}
    ${lbl("N", 66, 31)}${lbl("E", 101, 66)}${lbl("S", 66, 101)}${lbl("W", 31, 66)}${arrow}
    <circle cx="66" cy="66" r="22" fill="rgba(12,28,52,.9)"/>
    <text x="66" y="62" fill="#fff" font-size="18" font-weight="600" text-anchor="middle">${num(speed)}</text>
    <text x="66" y="77" fill="rgba(255,255,255,.75)" font-size="10" font-weight="600" text-anchor="middle">${unit}</text></svg>`;
}

/* ---------------- Rendering: alerts ---------------- */

const SEV_RANK = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3, Unknown: 4 };
function renderAlerts(alerts) {
  if (!alerts.length) {
    card("c-alerts", { cls: "ok-card", body: `${glyph("check")}<span>No active severe weather alerts.<br><span class="muted" style="font-size:13px">National Weather Service</span></span>` });
    return;
  }
  alerts.sort((a, b) => (SEV_RANK[a.severity] ?? 4) - (SEV_RANK[b.severity] ?? 4));
  const top = (alerts[0].severity || "minor").toLowerCase();
  const items = alerts.slice(0, 4).map(a => `<div class="alert-item"><div class="alert-ev">${esc(a.event)}</div>
    <div class="alert-meta">${a.expires || a.ends ? "Until " + esc(zoned(a.ends || a.expires, state.tz)) + " · " : ""}${esc(a.senderName || "National Weather Service")}</div></div>`).join("");
  const more = alerts.length > 4 ? `<div class="card-note">+${alerts.length - 4} more</div>` : "";
  card("c-alerts", { title: alerts.length > 1 ? `${alerts.length} Weather Alerts` : "Severe Weather", glyphKey: "alert", cls: "alert-card " + top, action: "alerts", body: items + more });
}

function alertsSheet() {
  const list = state.alerts || [];
  openSheet("Weather Alerts", list.map(a => `
    <h3>${esc([a.severity, a.urgency].filter(x => x && x !== "Unknown").join(" · "))}</h3>
    <div class="group" style="padding:14px 16px">
      <div style="font-size:20px;font-weight:700">${esc(a.event)}</div>
      ${a.headline ? `<p class="prose" style="margin:6px 0 0;font-weight:600">${esc(a.headline)}</p>` : ""}
      <p class="small" style="margin:8px 0 0">${esc([a.onset || a.effective ? "From " + zoned(a.onset || a.effective, state.tz) : "", a.ends || a.expires ? "Until " + zoned(a.ends || a.expires, state.tz) : ""].filter(Boolean).join(" · "))}</p>
      ${a.areaDesc ? `<p class="small" style="margin:4px 0 0">${esc(a.areaDesc)}</p>` : ""}
      ${a.description ? `<hr class="rule"><p class="prose">${esc(a.description.replace(/([^\n])\n(?!\n)/g, "$1 "))}</p>` : ""}
      ${a.instruction ? `<hr class="rule"><p class="prose"><b>What to do:</b> ${esc(a.instruction.replace(/([^\n])\n(?!\n)/g, "$1 "))}</p>` : ""}
      <p class="small">${esc(a.senderName || "National Weather Service")}</p>
    </div>`).join("") + `<p class="small">Source: <a href="https://www.weather.gov/" target="_blank" rel="noopener">National Weather Service</a>. In an emergency follow local officials.</p>`);
}

/* ---------------- Rendering: air quality ---------------- */

const AQI_CATS = [[50, "Good", "Air quality is satisfactory and poses little or no risk."], [100, "Moderate", "Unusually sensitive people should consider limiting prolonged outdoor exertion."],
  [150, "Unhealthy for Sensitive Groups", "Sensitive groups should reduce prolonged or heavy outdoor exertion."], [200, "Unhealthy", "Everyone may begin to experience health effects; limit time outdoors."],
  [300, "Very Unhealthy", "Health alert: everyone should avoid prolonged outdoor exertion."], [Infinity, "Hazardous", "Health warning of emergency conditions. Stay indoors."]];
const aqiCat = v => AQI_CATS.find(c => v <= c[0]);
const POLLUTANT_NAMES = { pm2_5: "PM2.5", pm10: "PM10", ozone: "Ozone", nitrogen_dioxide: "NO₂", sulphur_dioxide: "SO₂", carbon_monoxide: "CO", "PM2.5": "PM2.5", PM10: "PM10", O3: "Ozone", OZONE: "Ozone" };

function renderAir(air) {
  const v = air.aqi, [, cat, advice] = aqiCat(v);
  card("c-aqi", {
    title: "Air Quality", glyphKey: "aqi", action: "air",
    body: `<div class="big">${num(v)}</div><div class="sub">${esc(cat)}</div>
      <div class="scale aqi"><i class="dot" style="left:${Math.min(100, v / 300 * 100).toFixed(1)}%"></i></div>
      <div class="card-note">${air.primary ? `Now driven by ${esc(air.primary)}. ` : ""}${esc(advice)}</div>`,
  });
}

function airSheet() {
  const a = state.air;
  if (!a) return;
  const rows = (a.pollutants || []).map(p => `<div class="row"><span>${esc(p.name)}</span><span>${p.aqi != null ? "AQI " + num(p.aqi) : ""}${p.conc != null ? `${p.aqi != null ? " · " : ""}${num(p.conc, 1)} ${esc(p.unit || "")}` : ""}</span></div>`).join("");
  openSheet("Air Quality", `
    <div class="group" style="padding:14px 16px"><div class="big">${num(a.aqi)}</div><div class="sub">${esc(aqiCat(a.aqi)[1])}</div>
      <div class="scale aqi"><i class="dot" style="left:${Math.min(100, a.aqi / 300 * 100).toFixed(1)}%"></i></div>
      <p class="small" style="margin:8px 0 0">${esc(aqiCat(a.aqi)[2])}</p></div>
    ${rows ? `<h3>Pollutants</h3><div class="group">${rows}</div>` : ""}
    <h3>About</h3><div class="group">${AQI_CATS.map((c, i) => `<div class="row"><span>${c[1]}</span><span>${i ? AQI_CATS[i - 1][0] + 1 : 0}${c[0] === Infinity ? "+" : "–" + c[0]}</span></div>`).join("")}</div>
    <p class="small">${esc(a.source)}${a.area ? " · " + esc(a.area) : ""}${a.time ? " · " + esc(a.time) : ""}. U.S. EPA Air Quality Index.</p>`);
}

function camsToAir(j) {
  const c = j.current || {}, u = j.current_units || {};
  const keys = ["pm2_5", "pm10", "ozone", "nitrogen_dioxide", "sulphur_dioxide", "carbon_monoxide"];
  const pollutants = keys.filter(k => c[k] != null || c["us_aqi_" + k] != null)
    .map(k => ({ key: k, name: POLLUTANT_NAMES[k], aqi: c["us_aqi_" + k], conc: c[k], unit: u[k] }));
  const top = pollutants.filter(p => p.aqi != null).sort((a, b) => b.aqi - a.aqi)[0];
  if (c.us_aqi == null) return null;
  return { aqi: c.us_aqi, primary: top && c.us_aqi > 50 ? top.name : "", pollutants, source: "Copernicus Atmosphere Monitoring Service (CAMS) model via Open-Meteo" };
}

function airnowToAir(rows) {
  const best = rows.slice().sort((a, b) => b.AQI - a.AQI)[0];
  return {
    aqi: best.AQI, primary: best.AQI > 50 ? (POLLUTANT_NAMES[best.ParameterName] || best.ParameterName) : "",
    pollutants: rows.map(r => ({ name: POLLUTANT_NAMES[r.ParameterName] || r.ParameterName, aqi: r.AQI })),
    source: "U.S. EPA AirNow monitors", area: `${best.ReportingArea}, ${best.StateCode}`, time: `${best.DateObserved.trim()} ${best.HourObserved}:00 ${best.LocalTimeZone || ""}`.trim(),
  };
}

/* ---------------- Rendering: pollen ---------------- */

const LEVELS = ["None", "Very Low", "Low", "Moderate", "High", "Very High"];
const LEVEL_COLORS = ["rgba(255,255,255,.16)", "#5fd08a", "#a8dc4b", "#ffd60a", "#ff9f0a", "#ff453a"];
// CAMS reports grains/m³; rough clinical thresholds per pollen group.
const GRAIN_THRESH = { tree: [1, 15, 90, 500, 1500], grass: [1, 5, 20, 200, 500], weed: [1, 5, 10, 50, 500] };
const grainsToLevel = (v, group) => { if (!v || v < 1) return 0; const t = GRAIN_THRESH[group]; let l = 0; for (let i = 0; i < t.length; i++) if (v >= t[i]) l = i + 1; return Math.min(5, l); };

function pollenRow(name, level, note) {
  const bars = [1, 2, 3, 4, 5].map(i => `<i style="${i <= level ? `background:${LEVEL_COLORS[level]}` : ""}"></i>`).join("");
  return `<div class="prow"><span class="n">${esc(name)}</span><span class="bars">${bars}</span><span class="lvl">${esc(note || LEVELS[level])}</span></div>`;
}

function renderPollen(p) {
  if (!p) return;
  if (p.missing) {
    card("c-pollen", { title: "Pollen", glyphKey: "leaf", action: "settings", body: `<div class="card-text">No U.S. government agency publishes pollen counts.</div>
      <div class="card-note">Add a free Google Pollen API key in Settings to see tree, grass and weed pollen with the plant species in season.</div>` });
    return;
  }
  const rows = p.types.map(t => pollenRow(t.name, t.level, t.inSeason === false ? "Out of season" : null)).join("");
  const sp = p.species.filter(s => s.level > 0 || s.inSeason).sort((a, b) => b.level - a.level);
  const chips = sp.length ? `<div class="species">${sp.map(s => `<span class="chip">${esc(s.name)}<b>${esc(LEVELS[s.level])}</b></span>`).join("")}</div>` : "";
  const worst = p.types.slice().sort((a, b) => b.level - a.level)[0];
  card("c-pollen", {
    title: "Pollen", glyphKey: "leaf",
    body: `<div class="pollen-rows">${rows}</div>${chips}
      <div class="card-note">${worst && worst.level >= 3 ? `${worst.name} pollen is ${LEVELS[worst.level].toLowerCase()} today${sp[0] ? `, mostly ${sp.filter(s => s.level >= 2).slice(0, 3).map(s => s.name.toLowerCase()).join(", ") || sp[0].name.toLowerCase()}` : ""}.` : "Pollen levels are low today."} <span class="muted">${esc(p.source)}</span></div>`,
  });
}

function googleToPollen(j) {
  const day = (j.dailyInfo || [])[0];
  if (!day) return null;
  const typeName = { TREE: "Tree", GRASS: "Grass", WEED: "Weed" };
  const types = ["TREE", "GRASS", "WEED"].map(code => {
    const t = (day.pollenTypeInfo || []).find(x => x.code === code) || {};
    return { name: typeName[code], level: (t.indexInfo && t.indexInfo.value) || 0, inSeason: t.inSeason };
  });
  const species = (day.plantInfo || []).map(s => ({ name: s.displayName || titleCase(s.code), level: (s.indexInfo && s.indexInfo.value) || 0, inSeason: !!s.inSeason }));
  return { types, species, source: "Google Pollen API" };
}

function camsToPollen(j) {
  const c = j.current || {};
  if (POLLEN_VARS.every(k => c[k] == null)) return null;
  const sp = [["Alder", "alder_pollen", "tree"], ["Birch", "birch_pollen", "tree"], ["Olive", "olive_pollen", "tree"], ["Grass", "grass_pollen", "grass"], ["Mugwort", "mugwort_pollen", "weed"], ["Ragweed", "ragweed_pollen", "weed"]]
    .map(([name, k, g]) => ({ name, group: g, grains: c[k], level: grainsToLevel(c[k], g) }));
  const groupLevel = g => Math.max(0, ...sp.filter(s => s.group === g).map(s => s.level));
  return {
    types: [{ name: "Tree", level: groupLevel("tree") }, { name: "Grass", level: groupLevel("grass") }, { name: "Weed", level: groupLevel("weed") }],
    species: sp.filter(s => s.name !== "Grass"), source: "Copernicus CAMS via Open-Meteo",
  };
}

/* ---------------- Rendering: wildfire ---------------- */

function renderFire(place, fires) {
  if (!fires.length) {
    card("c-fire", { title: "Nearest Fire", glyphKey: "flame", cls: "square", body: `<div class="sub">None</div><div class="card-note">No active wildfires reported in the U.S.</div>` });
    return;
  }
  const ranked = fires.map(f => ({ ...f, mi: distanceMiles(place, f), brg: bearing(place, f) })).sort((a, b) => a.mi - b.mi);
  state.fires = ranked.slice(0, 8);
  const n = ranked[0], within = ranked.filter(f => f.mi <= 50).length;
  card("c-fire", {
    title: "Nearest Fire", glyphKey: "flame", cls: "square", action: "fires",
    body: `<div class="fire-head"><div class="big">${num(n.mi, n.mi < 10 ? 1 : 0)}<small>mi</small></div>
        <span class="fire-arrow" style="transform:rotate(${n.brg.toFixed(0)}deg)" aria-hidden="true">${glyph("arrow", 2.6)}</span></div>
      <div class="sub" style="font-size:16px">${compass(n.brg)} · ${esc(n.name)}</div>
      <div class="card-note">${n.acres != null ? num(n.acres) + " acres" : "Size unknown"}${n.contained != null ? ` · ${num(n.contained)}% contained` : ""}${within > 1 ? ` · ${within} fires within 50 mi` : ""}</div>`,
  });
}

function firesSheet() {
  const list = state.fires || [];
  openSheet("Nearby Wildfires", `<div class="group">${list.map(f => `<div class="row"><span><b>${esc(f.name)}</b><br><span class="small" style="margin:0">${[f.county, f.state].filter(Boolean).map(esc).join(", ")}${f.discovered ? " · since " + new Date(f.discovered).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : ""}</span></span>
      <span>${num(f.mi, f.mi < 10 ? 1 : 0)} mi ${compass(f.brg)}<br><span class="small" style="margin:0">${f.acres != null ? num(f.acres) + " ac" : ""}${f.contained != null ? " · " + num(f.contained) + "%" : ""}</span></span></div>`).join("")}</div>
    <p class="small">Straight-line distance and direction from ${esc(state.place && state.place.name || "this location")}. Source: <a href="https://data-nifc.opendata.arcgis.com/" target="_blank" rel="noopener">National Interagency Fire Center (WFIGS)</a>. Follow evacuation orders from local authorities.</p>`);
}

/* ---------------- Sources footer ---------------- */

function renderSources(place) {
  const us = isUS(place);
  $("#sources").innerHTML = `Weather: <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> (${us ? "NOAA HRRR / GFS" : "national weather service"} models)
    ${us ? `· Alerts: <a href="https://www.weather.gov/" target="_blank" rel="noopener">NWS</a> · Fires: <a href="https://www.nifc.gov/" target="_blank" rel="noopener">NIFC</a>` : ""}
    <br>Air quality: ${settings.airnowKey && us ? "EPA AirNow / " : ""}Copernicus CAMS · Pollen: ${settings.pollenKey ? "Google Pollen" : "Copernicus CAMS"}
    <br>Updated ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

/* ---------------- Sheets ---------------- */

function openSheet(title, html, { full = false, left = "", onOpen } = {}) {
  const root = $("#sheet-root");
  root.innerHTML = `<div class="scrim" data-close></div>
    <div class="sheet ${full ? "full" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="grabber"></div>
      <div class="sheet-top">${left || '<span class="spacer"></span>'}<h2>${esc(title)}</h2><button class="glass-btn round" type="button" data-close aria-label="Close">${glyph("x", 2.6)}</button></div>
      <div class="sheet-body">${html}</div></div>`;
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add("open")));
  root.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", closeSheet));
  // Drag the grabber down to dismiss.
  const sheet = root.querySelector(".sheet");
  let y0 = null;
  root.querySelector(".grabber").parentElement.addEventListener("touchstart", e => { if (e.target.closest(".sheet-body")) return; y0 = e.touches[0].clientY; }, { passive: true });
  sheet.addEventListener("touchmove", e => { if (y0 == null) return; const dy = Math.max(0, e.touches[0].clientY - y0); sheet.style.transition = "none"; sheet.style.transform = `translateY(${dy}px)`; }, { passive: true });
  sheet.addEventListener("touchend", e => {
    if (y0 == null) return;
    const dy = e.changedTouches[0].clientY - y0; y0 = null; sheet.style.transition = ""; sheet.style.transform = "";
    if (dy > 90) closeSheet();
  });
  if (onOpen) onOpen(root);
  return root;
}
function closeSheet() {
  const root = $("#sheet-root");
  root.classList.remove("open");
  setTimeout(() => { if (!root.classList.contains("open")) root.innerHTML = ""; }, 380);
}

function searchSheet() {
  const listHTML = () => {
    const cards = saved.map((p, i) => `<div class="loc" data-i="${i}" role="button" tabindex="0" style="--a:#2a78d6;--b:#7fb8ee">
        <div class="l1"><div><div class="ln">${esc(p.name)}</div><div class="ls">${esc([p.admin, p.cc === "US" ? "" : p.country].filter(Boolean).join(", "))}</div></div><div class="lt">--</div></div>
        <div class="l2"><span class="lc"></span><span class="lh"></span></div>
        ${state.editing ? `<button class="del" type="button" data-del="${i}" aria-label="Remove ${esc(p.name)}">−</button>` : ""}</div>`).join("");
    return saved.length ? cards : `<p class="hint">Search for a city, then tap <b>Add</b> to keep it here.</p>`;
  };
  const left = `<button class="glass-btn round" type="button" id="open-settings" aria-label="Settings">${glyph("more", 3.6)}</button>`;
  openSheet("Weather", `
    <label class="searchfield">${glyph("search", 2.4)}<input id="q" type="search" placeholder="Search for a city or ZIP" autocomplete="off" autocapitalize="words" enterkeyhint="search"></label>
    <div class="results" id="results"></div>
    <div id="saved-wrap"><div style="display:flex;justify-content:space-between;align-items:center"><h3>Saved</h3>${saved.length ? `<button class="glass-btn text" id="edit" type="button" style="height:32px;font-size:14px;padding:0 14px">${state.editing ? "Done" : "Edit"}</button>` : ""}</div>
    <div id="saved">${listHTML()}</div></div>`, {
    full: true, left, onOpen: root => {
      const q = $("#q", root), results = $("#results", root);
      let timer, seq = 0;
      q.addEventListener("input", () => {
        clearTimeout(timer);
        const text = q.value.trim();
        $("#saved-wrap", root).hidden = !!text;
        if (text.length < 2) { results.innerHTML = ""; return; }
        timer = setTimeout(async () => {
          const my = ++seq;
          results.innerHTML = `<div class="hint">Searching…</div>`;
          try {
            const r = await geocode(text);
            if (my !== seq) return;
            state.results = r;
            results.innerHTML = r.length ? r.map((p, i) => `<button class="result" type="button" data-r="${i}">${esc(p.name)}<small>${esc([p.admin, p.country].filter(Boolean).join(", "))}</small></button>`).join("")
              : `<div class="hint">No results for “${esc(text)}”.</div>`;
          } catch { if (my === seq) results.innerHTML = `<div class="hint">Search is unavailable. Check your connection.</div>`; }
        }, 280);
      });
      results.addEventListener("click", e => {
        const b = e.target.closest("[data-r]"); if (!b) return;
        const p = state.results[+b.dataset.r];
        closeSheet();
        const i = saved.findIndex(s => Math.abs(s.lat - p.lat) < .01 && Math.abs(s.lon - p.lon) < .01);
        show(i >= 0 ? saved[i] : p, i >= 0 ? "saved" : "preview");
      });
      root.addEventListener("click", e => {
        const del = e.target.closest("[data-del]");
        if (del) { e.stopPropagation(); saved.splice(+del.dataset.del, 1); store.set("wx:saved", saved); $("#saved", root).innerHTML = listHTML(); fillLocCards(root); return; }
        if (e.target.closest("#edit")) { state.editing = !state.editing; e.target.closest("#edit").textContent = state.editing ? "Done" : "Edit"; $("#saved", root).innerHTML = listHTML(); fillLocCards(root); return; }
        if (e.target.closest("#open-settings")) { settingsSheet(); return; }
        const loc = e.target.closest(".loc[data-i]");
        if (loc && !state.editing) { closeSheet(); show(saved[+loc.dataset.i], "saved"); }
      });
      fillLocCards(root);
      if (!saved.length) setTimeout(() => q.focus(), 350);
    },
  });
}

function fillLocCards(root) {
  root.querySelectorAll(".loc[data-i]").forEach(el => {
    const p = saved[+el.dataset.i];
    getForecast(p).then(f => {
      const c = f.current, [a, b] = SKY_COLORS[skyFor(c.weather_code, c.is_day)];
      el.style.setProperty("--a", a); el.style.setProperty("--b", b);
      $(".lt", el).textContent = T(c.temperature_2m);
      $(".lc", el).textContent = condName(c.weather_code, c.is_day);
      $(".lh", el).textContent = `H:${T(f.daily.temperature_2m_max[0])}  L:${T(f.daily.temperature_2m_min[0])}`;
    }).catch(() => {});
  });
}

function settingsSheet() {
  const seg = [["auto", "Auto"], ["us", "°F · mph"], ["metric", "°C · km/h"]].map(([k, l]) => `<button type="button" data-u="${k}" class="${settings.units === k ? "on" : ""}">${l}</button>`).join("");
  openSheet("Settings", `
    <h3>Units</h3><div class="seg" id="seg">${seg}</div>
    <h3>Optional data keys</h3>
    <div class="group" style="padding:12px 16px">
      <label class="field"><span>EPA AirNow API key — official U.S. monitor AQI</span><input id="k-airnow" value="${esc(settings.airnowKey)}" placeholder="Not set: uses Copernicus CAMS" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
      <p class="small">Free from <a href="https://docs.airnowapi.org/account/request/" target="_blank" rel="noopener">docs.airnowapi.org</a>.</p>
      <label class="field"><span>Google Pollen API key — U.S. pollen with species</span><input id="k-pollen" value="${esc(settings.pollenKey)}" placeholder="Not set" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
      <p class="small">No U.S. agency publishes pollen counts. A Google Maps Platform key with the Pollen API enabled covers the U.S.; the free monthly allowance is plenty for one person. Keys are stored only on this device.</p>
    </div>
    <h3>Data sources</h3>
    <div class="group">
      <div class="row"><span>Forecast &amp; wind</span><span>Open-Meteo (NOAA, ECMWF, DWD models)</span></div>
      <div class="row"><span>Severe weather alerts</span><span>National Weather Service</span></div>
      <div class="row"><span>Wildfires</span><span>NIFC · WFIGS</span></div>
      <div class="row"><span>Air quality</span><span>EPA AirNow · Copernicus CAMS</span></div>
      <div class="row"><span>Pollen</span><span>Google Pollen · Copernicus CAMS</span></div>
      <div class="row"><span>Place search</span><span>Open-Meteo / GeoNames · NWS · OpenStreetMap</span></div>
    </div>
    <p class="small">For general information. Always follow official warnings and local authorities.</p>`, {
    onOpen: root => {
      $("#seg", root).addEventListener("click", e => {
        const b = e.target.closest("[data-u]"); if (!b) return;
        settings.units = b.dataset.u; store.set("wx:settings", settings);
        root.querySelectorAll("#seg button").forEach(x => x.classList.toggle("on", x === b));
        if (state.place) show(state.place, state.mode, true);
      });
      const save = () => {
        const a = $("#k-airnow", root).value.trim(), p = $("#k-pollen", root).value.trim();
        if (a === settings.airnowKey && p === settings.pollenKey) return;
        settings.airnowKey = a; settings.pollenKey = p; store.set("wx:settings", settings);
        memo.clear();
        if (state.place) show(state.place, state.mode, true);
      };
      root.querySelectorAll("input").forEach(i => i.addEventListener("change", save));
    },
  });
}

/* ---------------- Main flow ---------------- */

const state = { place: null, mode: null, seq: 0, tz: undefined, editing: false };

function setHeader(place, mode) {
  $("#h-sub").innerHTML = mode === "gps" ? `${locFill}<span>My Location</span>` : "";
  $("#h-name").textContent = place.name;
  $("#mini-name").textContent = place.name;
  $("#previewbar").hidden = mode !== "preview";
  $("#empty").hidden = true;
  $("#cards").hidden = false;
  document.title = place.name + " — Weather";
}

async function show(place, mode, quiet) {
  const my = ++state.seq;
  const live = () => my === state.seq;
  state.place = place; state.mode = mode; state.alerts = []; state.air = null; state.fires = [];
  setHeader(place, mode);
  if (!quiet) window.scrollTo({ top: 0 });
  if (mode !== "preview") store.set("wx:last", { place, mode });

  // Show the last copy straight away (offline / slow network), then refresh.
  const snap = store.get("wx:snap:" + ll(place), null);
  if (snap && snap.forecast && snap.forecast.imperial === imperial()) { try { renderForecast(snap.forecast, place); } catch { /* old shape */ } }
  else {
    ["#h-temp", "#h-cond", "#h-hl"].forEach(s => { $(s).innerHTML = "&nbsp;"; });
    loadingCard("c-hourly", "", "clock"); loadingCard("c-daily", "10-Day Forecast", "calendar"); loadingCard("c-wind", "Wind", "wind");
    clear("c-uv", "c-feels", "c-humid", "c-vis", "c-press", "c-sun", "c-precip");
  }
  clear("c-alerts", "c-fire");
  loadingCard("c-aqi", "Air Quality", "aqi"); loadingCard("c-pollen", "Pollen", "leaf");

  const fc = getForecast(place).then(f => {
    if (!live()) return;
    renderForecast(f, place);
    store.set("wx:snap:" + ll(place), { forecast: f, t: Date.now() });
  }).catch(() => {
    if (!live() || snap) return;
    errorCard("c-hourly", "Forecast", "clock", "Couldn't load the forecast. Pull down or reopen to try again.");
    clear("c-daily", "c-wind");
  });

  // Work out whether this is a U.S. location (and get a proper name for GPS fixes).
  if (place.gps || !place.cc) {
    try {
      const n = await reverseName(place);
      if (!live()) return;
      Object.assign(place, n);
      setHeader(place, mode);
      if (mode !== "preview") store.set("wx:last", { place, mode });
    } catch { /* keep "My Location" */ }
  }
  const us = isUS(place);
  renderSources(place);

  // Air quality: EPA AirNow when a key is set, else Copernicus CAMS.
  const cams = getCams(place).catch(() => null);
  (async () => {
    let air = null;
    if (us && settings.airnowKey) { try { air = airnowToAir(await getAirNow(place)); } catch { /* fall back */ } }
    if (!air) { const j = await cams; air = j && camsToAir(j); }
    if (!live()) return;
    state.air = air;
    if (air) renderAir(air); else errorCard("c-aqi", "Air Quality", "aqi", "Air quality isn't available right now.");
  })();

  // Pollen: Google (with key) → CAMS (Europe) → explain.
  (async () => {
    let p = null;
    if (settings.pollenKey) { try { p = googleToPollen(await getGooglePollen(place)); } catch { /* fall back */ } }
    if (!p) { const j = await cams; p = j && camsToPollen(j); }
    if (!live()) return;
    if (p) renderPollen(p);
    else if (us) renderPollen({ missing: true });
    else errorCard("c-pollen", "Pollen", "leaf", "Pollen data isn't available for this location.");
  })();

  if (us) {
    loadingCard("c-alerts", "Severe Weather", "alert");
    loadingCard("c-fire", "Nearest Fire", "flame");
    await fc; // alert times use the place's time zone
    getAlerts(place).then(a => { if (live()) { state.alerts = a; renderAlerts(a); } })
      .catch(() => { if (live()) errorCard("c-alerts", "Severe Weather", "alert", "Couldn't reach the National Weather Service for alerts."); });
    getFires().then(f => { if (live()) renderFire(place, f); })
      .catch(() => { if (live()) errorCard("c-fire", "Nearest Fire", "flame", "Wildfire data is unavailable right now."); });
  }
}

function locate(fromButton) {
  if (!navigator.geolocation) { if (fromButton) alert("Location isn't available on this device."); return fallback(); }
  navigator.geolocation.getCurrentPosition(pos => {
    const prev = store.get("wx:last", null);
    const place = { name: "My Location", gps: true, lat: pos.coords.latitude, lon: pos.coords.longitude };
    // Reuse the name from last time if we haven't moved far.
    if (prev && prev.mode === "gps" && distanceMiles(prev.place, place) < 2) Object.assign(place, { name: prev.place.name, admin: prev.place.admin, cc: prev.place.cc, country: prev.place.country });
    show(place, "gps");
  }, err => {
    if (fromButton && err.code === 1) alert("Location access is off. Turn it on in Settings › Privacy & Security › Location Services › Safari Websites.");
    if (!state.place) fallback();
  }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 5 * 60e3 });
}

function fallback() {
  if (saved.length) return show(saved[0], "saved");
  $("#h-name").textContent = "Weather";
  $("#cards").hidden = true;
  $("#empty").hidden = false;
}

/* ---------------- Wiring ---------------- */

$("#btn-locate").innerHTML = locFill;
$("#btn-list").innerHTML = glyph("list", 2.2);
$(".search-ico").innerHTML = glyph("search", 2.4);
$("#btn-locate").addEventListener("click", () => locate(true));
$("#btn-search").addEventListener("click", searchSheet);
$("#btn-list").addEventListener("click", searchSheet);
$("#empty-search").addEventListener("click", searchSheet);
$("#empty-locate").addEventListener("click", () => locate(true));
$("#pv-cancel").addEventListener("click", () => { const last = store.get("wx:last", null); last ? show(last.place, last.mode) : fallback(); });
$("#pv-add").addEventListener("click", () => {
  const p = state.place;
  saved.push({ name: p.name, admin: p.admin, country: p.country, cc: p.cc, lat: p.lat, lon: p.lon });
  store.set("wx:saved", saved);
  show(saved[saved.length - 1], "saved", true);
});
$("#cards").addEventListener("click", e => {
  const a = e.target.closest("[data-action]"); if (!a) return;
  ({ alerts: alertsSheet, air: airSheet, fires: firesSheet, settings: settingsSheet })[a.dataset.action]();
});
document.addEventListener("keydown", e => { if (e.key === "Escape") closeSheet(); });

// Compact title once the big header scrolls away.
const mini = $("#mini");
addEventListener("scroll", () => { mini.classList.toggle("show", $("#hero").getBoundingClientRect().bottom < 70); }, { passive: true });

// Refresh when coming back to the app after a while.
let hiddenAt = 0;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (hiddenAt && Date.now() - hiddenAt > 10 * 60e3) { memo.clear(); state.mode === "gps" ? locate() : state.place && show(state.place, state.mode, true); }
});

(function boot() {
  const last = store.get("wx:last", null);
  // Open on the current position, like the Weather app; show the last place while the fix comes in.
  if (last && last.place) show(last.place, last.mode);
  locate();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(r => r.update()).catch(() => {});
})();
