/**
 * weather-to-inputs.js
 * ---------------------
 * Takes the raw object from weather-data.js and buckets/transforms it
 * into the exact `inputs` shape your visualization script expects.
 * Kept separate from weather-data.js on purpose — this file is all
 * "business rules" / bucketing, no fetching.
 *
 * Usage:
 *   const data = await getWeatherData();       // from weather-data.js
 *   const inputs = mapWeatherToInputs(data);
 *
 * Or event-driven:
 *   window.addEventListener('weatherDataReady', (e) => {
 *     const inputs = mapWeatherToInputs(e.detail);
 *     // ... feed inputs into your viz script
 *   });
 */

// ---- Tunable thresholds — adjust these freely, nothing else needs to change ----
const THRESHOLDS = {
  heat: { low: 15, mid: 25 }, // <=15 -> 1, <=25 -> 2, >25 -> 3 (as you specified)
  windSpeedKmh: [5, 20, 40, 60, 80], // 5 buckets -> windspeed 0-5 (ASSUMPTION, tweak freely)
  heavyRainMm: 4, // mm in the current hour; >= this -> 'H', below -> 'R' (ASSUMPTION)
};

// ---- sunpos / moonpos -------------------------------------------------
// midday = 0/1, midnight = 0.5, moving clockwise round the circle.

function minutesFromTimeStr(timeStr) {
  const match = timeStr.match(/T(\d{2}):(\d{2})/);
  return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
}

function hourFractionFromLocalTime(localTimeStr) {
  const match = localTimeStr.match(/T(\d{2}):(\d{2})/);
  const hh = parseInt(match[1], 10);
  const mm = parseInt(match[2], 10);
  return (hh + mm / 60) / 24;
}

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
}

// Sun travels the upper arc (0.75→0→0.25) during the actual day period
// (sunrise→sunset) and the lower arc (0.25→0.5→0.75) during night.
// This means 1 hr of a long summer day spans less arc than 1 hr of
// the short summer night — the sun just moves faster at night.
// Quadratic ease-in-out is applied within each period so the speed
// transition at sunrise/sunset is smooth rather than abrupt.
function sunPosFromActualTimes(localTimeStr, sunriseStr, sunsetStr) {
  const nowMins  = minutesFromTimeStr(localTimeStr);
  const riseMins = minutesFromTimeStr(sunriseStr);
  const setMins  = minutesFromTimeStr(sunsetStr);

  const dayDur   = setMins - riseMins;
  const nightDur = 24 * 60 - dayDur;

  if (nowMins >= riseMins && nowMins <= setMins) {
    const t = easeInOut((nowMins - riseMins) / dayDur);
    return (0.75 + t * 0.5) % 1;
  } else {
    const nightMins = nowMins >= setMins
      ? nowMins - setMins
      : (24 * 60 - setMins) + nowMins;
    const t = easeInOut(nightMins / nightDur);
    return 0.25 + t * 0.5;
  }
}

// Moon moves at constant speed over 24 h regardless of sunrise/sunset.
// Its offset from the sun is proportional to phase fraction.
function moonPosFromHourFraction(hourFraction, phaseFraction) {
  const moonHourFraction = (hourFraction + phaseFraction) % 1;
  return (moonHourFraction + 0.5) % 1;
}

// ---- heat ---------------------------------------------------------------
function bucketHeat(tempC) {
  if (tempC <= THRESHOLDS.heat.low) return 1;
  if (tempC <= THRESHOLDS.heat.mid) return 2;
  return 3;
}

// ---- moonstate (1-8) -----------------------------------------------------
// Your convention, derived from the anchors you gave me:
//   5 = new/dark moon         (phaseFraction 0.0)
//   6 = waxing crescent       (phaseFraction 0.125)
//   7 = first quarter, left lit (phaseFraction 0.25)
//   8 = waxing gibbous, small shadow on right (phaseFraction 0.375)
//   1 = full moon             (phaseFraction 0.5)
//   2 = waning gibbous        (phaseFraction 0.625)
//   3 = last quarter, right lit (phaseFraction 0.75)
//   4 = waning crescent       (phaseFraction 0.875)
function bucketMoonState(phaseFraction) {
  const bucket = Math.round(phaseFraction * 8) % 8; // 0-7, 0 = new moon
  return ((bucket + 4) % 8) + 1; // remaps to your 1-8 numbering
}

// ---- windspeed (0-5) -------------------------------------------------
function bucketWindSpeed(speedKmh) {
  const t = THRESHOLDS.windSpeedKmh;
  for (let i = 0; i < t.length; i++) {
    if (speedKmh < t[i]) return i;
  }
  return t.length; // fastest bucket
}

// ---- direction (L/R) ---------------------------------------------------
// North = L, South = R, West side = L, East side = R (as you specified).
function bucketDirection(deg) {
  const d = ((deg % 360) + 360) % 360;
  if (d === 0) return "L"; // due north
  if (d === 180) return "R"; // due south
  return d > 0 && d < 180 ? "R" : "L"; // east half -> R, west half -> L
}

// ---- precipitation (N/R/H/S) -----------------------------------------
function bucketPrecipitation({ amount, type }) {
  if (type === "snow") return "S";
  if (type === "none" || amount <= 0) return "N";
  return amount >= THRESHOLDS.heavyRainMm ? "H" : "R";
}

// ---- density (cloud coverage 0-1) --------------------------------------
function bucketDensity(coveragePercent) {
  return Number((coveragePercent / 100).toFixed(2));
}

// ---- Main mapping function --------------------------------------------
function mapWeatherToInputs(weatherData) {
  const hourFraction = hourFractionFromLocalTime(weatherData.localTime);
  const sunpos = sunPosFromActualTimes(
    weatherData.localTime,
    weatherData.sun.sunrise,
    weatherData.sun.sunset
  );
  const moonpos = moonPosFromHourFraction(hourFraction, weatherData.moon.phaseFraction);

  return {
    sunpos: { value: sunpos.toFixed(2) },
    moonpos: { value: moonpos.toFixed(2) },
    heat: { value: String(bucketHeat(weatherData.temperature.value)) },
    moonstate: { value: String(bucketMoonState(weatherData.moon.phaseFraction)) },
    // horizon: not yet mapped — see note in chat
    windspeed: { value: String(bucketWindSpeed(weatherData.wind.speed)) },
    direction: { value: bucketDirection(weatherData.wind.directionDeg) },
    density: { value: String(bucketDensity(weatherData.clouds.coveragePercent)) },
    precipitation: { value: bucketPrecipitation(weatherData.precipitation) },
  };
}

window.mapWeatherToInputs = mapWeatherToInputs;
