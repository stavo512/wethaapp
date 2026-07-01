/**
 * weather-data.js
 * ----------------
 * Standalone data-collection module. Fetches current + hourly forecast
 * weather for a location (default: Schengen, Luxembourg) and computes
 * moon illumination/phase locally. Knows nothing about the
 * visualization — it just produces a clean data object.
 *
 * Two ways to consume this from your other script:
 *
 *   1) Direct call:
 *        const data = await getWeatherData();
 *
 *   2) Event-driven (no import/await needed in the other file):
 *        window.addEventListener('weatherDataReady', (e) => {
 *          console.log(e.detail); // same object as above
 *        });
 *        startWeatherPolling(); // call once, fires immediately + every interval
 *
 * The returned object's top level is a "now" snapshot (location,
 * observedAt, localTime, temperature, humidity, precipitation, wind,
 * clouds, sun, moon). It also carries a `hourly` array of snapshots in
 * that exact same shape, one per hour, starting at the current hour
 * (rounded) and running forecast_days ahead — so any consumer that
 * knows how to read the top-level object already knows how to read
 * any entry in `hourly`.
 *
 * No API key needed — Open-Meteo's free tier covers all of this.
 */

// ---- Location -------------------------------------------------------
// Schengen, Luxembourg (the actual village, not just "the Schengen area")
const DEFAULT_LOCATION = {
  name: "currentplace",
  latitude: 69.8157,
  longitude: 18.5515,
};

const FORECAST_DAYS = 3; // enough headroom for the "tomorrow at noon" slot

// ---- WMO weather_code -> precipitation type (fallback only) ---------
// Open-Meteo also gives us rain/showers/snowfall directly, which is more
// reliable than decoding the code, but this fills gaps (e.g. drizzle,
// thunderstorm) that those fields don't distinguish on their own.
function codeToType(code) {
  if ([95, 96, 99].includes(code)) return "thunderstorm";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "snow";
  if ([51, 53, 55, 56, 57].includes(code)) return "drizzle";
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "rain";
  return "none";
}

function getPrecipitationType({ rain, showers, snowfall, weather_code }) {
  if (snowfall > 0) return "snow";
  if (rain > 0 || showers > 0) return "rain";
  return codeToType(weather_code);
}

// ---- Moon phase / illumination (no API — pure astronomy) ------------
// Reference new moon: 2000-01-06 18:14 UTC. Synodic month ~29.53059 days.
// Accurate to well within a day, which is plenty for a sketch-style UI.
function getMoonData(date = new Date()) {
  const SYNODIC_MONTH = 29.530588861;
  const KNOWN_NEW_MOON = Date.UTC(2000, 0, 6, 18, 14, 0);

  const daysSinceRef = (date.getTime() - KNOWN_NEW_MOON) / 86400000;
  let ageDays = daysSinceRef % SYNODIC_MONTH;
  if (ageDays < 0) ageDays += SYNODIC_MONTH;

  const phaseFraction = ageDays / SYNODIC_MONTH; // 0 = new, 0.5 = full, 1 = new again
  const phaseAngleDeg = phaseFraction * 360;
  const illumination = (1 - Math.cos(2 * Math.PI * phaseFraction)) / 2; // 0..1

  return {
    ageDays: Number(ageDays.toFixed(2)),
    phaseFraction: Number(phaseFraction.toFixed(4)), // raw 0-1, you bucket this
    phaseAngleDeg: Number(phaseAngleDeg.toFixed(1)), // raw 0-360, you bucket this
    illumination: Number(illumination.toFixed(4)), // raw 0-1 (% lit), you bucket this
  };
}

// ---- Snapshot builder (shared by the "current" and "hourly" slots) ---
// localTimeStr is local to the queried location, with no UTC offset
// attached (e.g. "2026-06-26T14:00"). Reinterpreting that string in the
// *browser's* timezone would be wrong if it differs from the location's
// timezone. utcOffsetSeconds lets us recover the true absolute instant.
function buildSnapshot(location, localTimeStr, vals, units, utcOffsetSeconds, sunInfo) {
  const trueUtcMs = Date.parse(localTimeStr + "Z") - utcOffsetSeconds * 1000;
  const observedAt = new Date(trueUtcMs);

  return {
    location: {
      name: location.name,
      latitude: location.latitude,
      longitude: location.longitude,
    },
    observedAt: observedAt.toISOString(), // true absolute instant (for moon math)
    localTime: localTimeStr, // local clock time at the location (for sun-position math)

    temperature: {
      value: vals.temperature_2m,
      unit: units.temperature_2m,
    },

    humidity: {
      value: vals.relative_humidity_2m,
      unit: units.relative_humidity_2m,
    },

    precipitation: {
      amount: vals.precipitation,
      unit: units.precipitation,
      type: getPrecipitationType(vals),
    },

    wind: {
      speed: vals.wind_speed_10m,
      speedUnit: units.wind_speed_10m,
      directionDeg: vals.wind_direction_10m, // 0-360, meteorological "from" direction
    },

    clouds: {
      coveragePercent: vals.cloud_cover, // 0-100
    },

    sun: {
      isDay: vals.is_day === 1,
      sunrise: sunInfo.sunrise,
      sunset: sunInfo.sunset,
    },

    moon: getMoonData(observedAt),
  };
}

// rounds a location-local "YYYY-MM-DDTHH:MM" string to the nearest hour,
// expressed in that same naive format. Pure calendar arithmetic — never
// reinterprets the string in the browser's timezone.
function roundToHourString(localTimeStr) {
  const m = localTimeStr.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  const [y, mo, d, h0, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
  const h = mi >= 30 ? h0 + 1 : h0;
  const dt = new Date(Date.UTC(y, mo - 1, d, h));
  const pad = (n) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}T${pad(dt.getUTCHours())}:00`;
}

// ---- Main fetch -------------------------------------------------------
async function getWeatherData(location = DEFAULT_LOCATION) {
  const params = new URLSearchParams({
    latitude: location.latitude,
    longitude: location.longitude,
    current: [
      "temperature_2m",
      "relative_humidity_2m",
      "precipitation",
      "rain",
      "showers",
      "snowfall",
      "weather_code",
      "wind_speed_10m",
      "wind_direction_10m",
      "cloud_cover",
      "is_day",
    ].join(","),
    hourly: [
      "temperature_2m",
      "relative_humidity_2m",
      "precipitation",
      "rain",
      "showers",
      "snowfall",
      "weather_code",
      "wind_speed_10m",
      "wind_direction_10m",
      "cloud_cover",
      "is_day",
    ].join(","),
    daily: "sunrise,sunset",
    forecast_days: FORECAST_DAYS,
    timezone: "auto",
  });

  const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo request failed: ${res.status}`);
  const raw = await res.json();

  const sunInfo = { sunrise: raw.daily.sunrise[0], sunset: raw.daily.sunset[0] };

  const data = buildSnapshot(
    location,
    raw.current.time,
    raw.current,
    raw.current_units,
    raw.utc_offset_seconds,
    sunInfo
  );

  // hourly[0] starts at "now" (rounded to the nearest hour) so that
  // hourly[N] always means "N hours from now" for any consumer.
  const baseHourStr = roundToHourString(raw.current.time);
  let baseIdx = raw.hourly.time.indexOf(baseHourStr);
  if (baseIdx === -1) baseIdx = 0;

  data.hourly = raw.hourly.time.slice(baseIdx).map((t, i) => {
    const idx = baseIdx + i;
    const vals = {
      temperature_2m: raw.hourly.temperature_2m[idx],
      relative_humidity_2m: raw.hourly.relative_humidity_2m[idx],
      precipitation: raw.hourly.precipitation[idx],
      rain: raw.hourly.rain[idx],
      showers: raw.hourly.showers[idx],
      snowfall: raw.hourly.snowfall[idx],
      weather_code: raw.hourly.weather_code[idx],
      wind_speed_10m: raw.hourly.wind_speed_10m[idx],
      wind_direction_10m: raw.hourly.wind_direction_10m[idx],
      cloud_cover: raw.hourly.cloud_cover[idx],
      is_day: raw.hourly.is_day[idx],
    };
    return buildSnapshot(location, t, vals, raw.hourly_units, raw.utc_offset_seconds, sunInfo);
  });

  return data;
}

// finds the hourly snapshot whose localTime matches exactly (hourly
// entries are always on the hour, so exact lookups are the common case)
function findSlotByLocalTime(hourlyArray, localTimeStr) {
  return hourlyArray.find((s) => s.localTime === localTimeStr) || null;
}

// ---- Optional event-driven polling, for loose coupling ---------------
let pollHandle = null;

function startWeatherPolling(intervalMs = 10 * 60 * 1000, location = DEFAULT_LOCATION) {
  const tick = async () => {
    try {
      const data = await getWeatherData(location);
      window.dispatchEvent(new CustomEvent("weatherDataReady", { detail: data }));
    } catch (err) {
      window.dispatchEvent(new CustomEvent("weatherDataError", { detail: err }));
    }
  };
  tick(); // fire immediately
  pollHandle = setInterval(tick, intervalMs);
  return pollHandle;
}

function stopWeatherPolling() {
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = null;
}

// Expose globally for plain <script> usage (no bundler in this prototype)
window.getWeatherData = getWeatherData;
window.startWeatherPolling = startWeatherPolling;
window.stopWeatherPolling = stopWeatherPolling;
window.findSlotByLocalTime = findSlotByLocalTime;
