// GUEST FLOW CHART
// ═══════════════════════════════════════════════════════════════════
// Shows estimated guest arrivals per 5-minute interval as a line chart.
// Uses a gaussian distribution applied to the expected total guest count.

let _guestFlowMeal = 'lunch'; // current toggle state

function setGuestFlowMeal(meal) {
  _guestFlowMeal = meal;
  document.querySelectorAll('.dash-flow-toggle').forEach(b => b.classList.toggle('active', b.dataset.meal === meal));
  drawGuestFlowChart();
}

// Gaussian bell curve: returns value 0-1 centered at `center` with spread `sigma`
function gaussian(x, center, sigma) {
  return Math.exp(-0.5 * Math.pow((x - center) / sigma, 2));
}

// Build a distribution of guest arrivals per 5-min slot for a meal.
// Uses real historical distribution if available, falls back to gaussian.
// Returns array of { time: "HH:MM", guests: number }
function buildGuestFlowData(totalGuests, meal, loc) {
  // Check for real distribution data
  const today = getToday();
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dow = DAY_NAMES[today.getDay()];
  const dist = S.guestFlowDistribution;

  // Service windows: only show data within actual service hours
  const SERVICE_WINDOWS = {
    lunch:  { start: 12 * 60, end: 14 * 60 },
    dinner: { start: 18 * 60, end: 21 * 60 },
  };
  const win = SERVICE_WINDOWS[meal];

  if (dist && dist[loc] && dist[loc][meal] && dist[loc][meal][dow]) {
    const buckets = dist[loc][meal][dow];
    // Convert bucket map to sorted array, filter to service window
    const entries = Object.entries(buckets)
      .map(([minStr, frac]) => ({ min: parseInt(minStr), frac }))
      .filter(e => e.min >= win.start && e.min < win.end)
      .sort((a, b) => a.min - b.min);
    if (entries.length >= 3) {
      // Re-normalize fractions after filtering so they sum to 1
      const fracSum = entries.reduce((s, e) => s + e.frac, 0);
      const scale = fracSum > 0 ? 1 / fracSum : 1;
      return entries.map(e => {
        const h = Math.floor(e.min / 60);
        const m = e.min % 60;
        return {
          time: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
          guests: Math.round(e.frac * scale * totalGuests * 10) / 10
        };
      });
    }
  }

  // Fallback: gaussian distribution
  const LUNCH = { start: 12 * 60, end: 14 * 60, peak: 12 * 60 + 35, sigma: 22 };
  const DINNER = { start: 18 * 60, end: 21 * 60, peak: 19 * 60 + 10, sigma: 30 };
  const cfg = meal === 'lunch' ? LUNCH : DINNER;

  const slots = [];
  let totalWeight = 0;
  for (let t = cfg.start; t < cfg.end; t += 5) {
    const w = gaussian(t, cfg.peak, cfg.sigma);
    slots.push({ min: t, weight: w });
    totalWeight += w;
  }

  return slots.map(s => {
    const h = Math.floor(s.min / 60);
    const m = s.min % 60;
    return {
      time: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
      guests: Math.round((s.weight / totalWeight) * totalGuests * 10) / 10
    };
  });
}

function drawGuestFlowChart() {
  const canvas = document.getElementById('guest-flow-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  // HiDPI support
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  const w = rect.width;
  const h = 180;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);

  const loc = S.dashboardLoc;
  const todayIso = dateToIso(getToday());
  const totalGuests = getGuests(loc, todayIso, _guestFlowMeal);
  const data = buildGuestFlowData(totalGuests, _guestFlowMeal, loc);

  // Detect dark mode
  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const textColor = isDark ? '#a0a09a' : '#6b6b66';
  const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const lineColor = _guestFlowMeal === 'lunch' ? (isDark ? '#E4A84D' : '#BA7517') : (isDark ? '#8B82E0' : '#534AB7');
  const fillColor = _guestFlowMeal === 'lunch' ? (isDark ? 'rgba(228,168,77,0.12)' : 'rgba(186,117,23,0.08)') : (isDark ? 'rgba(139,130,224,0.12)' : 'rgba(83,74,183,0.08)');

  // Chart padding
  const pad = { top: 16, right: 16, bottom: 28, left: 36 };
  const cw = w - pad.left - pad.right;
  const ch = h - pad.top - pad.bottom;

  ctx.clearRect(0, 0, w, h);

  if (totalGuests === 0) {
    ctx.fillStyle = textColor;
    ctx.font = '13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No guest data for today', w / 2, h / 2);
    return;
  }

  const maxGuests = Math.max(...data.map(d => d.guests), 1);
  // Round up to nice number for y-axis
  const yMax = Math.ceil(maxGuests / 2) * 2 || 2;

  // X/Y mappers
  const xOf = i => pad.left + (i / (data.length - 1)) * cw;
  const yOf = v => pad.top + ch - (v / yMax) * ch;

  // Grid lines (3 horizontal)
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const yVal = (yMax / 3) * i;
    const y = yOf(yVal);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();
    // Y labels
    ctx.fillStyle = textColor;
    ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(Math.round(yVal), pad.left - 6, y + 3);
  }

  // X labels (every 30 minutes)
  ctx.fillStyle = textColor;
  ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  data.forEach((d, i) => {
    const mins = parseInt(d.time.split(':')[1]);
    if (mins === 0 || mins === 30) {
      ctx.fillText(d.time, xOf(i), h - 6);
    }
  });

  // Fill area under curve
  ctx.beginPath();
  ctx.moveTo(xOf(0), yOf(0));
  data.forEach((d, i) => ctx.lineTo(xOf(i), yOf(d.guests)));
  ctx.lineTo(xOf(data.length - 1), yOf(0));
  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.fill();

  // Line
  ctx.beginPath();
  data.forEach((d, i) => {
    if (i === 0) ctx.moveTo(xOf(i), yOf(d.guests));
    else ctx.lineTo(xOf(i), yOf(d.guests));
  });
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Current time indicator (vertical line if within service window)
  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const startMins = parseInt(data[0].time.split(':')[0]) * 60 + parseInt(data[0].time.split(':')[1]);
  const endMins = parseInt(data[data.length - 1].time.split(':')[0]) * 60 + parseInt(data[data.length - 1].time.split(':')[1]);
  if (nowMins >= startMins && nowMins <= endMins) {
    const progress = (nowMins - startMins) / (endMins - startMins);
    const nowX = pad.left + progress * cw;
    ctx.strokeStyle = isDark ? 'rgba(232,107,90,0.6)' : 'rgba(153,60,29,0.5)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(nowX, pad.top);
    ctx.lineTo(nowX, pad.top + ch);
    ctx.stroke();
    ctx.setLineDash([]);
    // "Now" label
    ctx.fillStyle = isDark ? '#E86B5A' : '#993C1D';
    ctx.font = 'bold 9px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Now', nowX, pad.top - 4);

    // Remaining guests: sum all slots after current time
    const remaining = Math.round(data.reduce((sum, d) => {
      const slotMins = parseInt(d.time.split(':')[0]) * 60 + parseInt(d.time.split(':')[1]);
      return sum + (slotMins >= nowMins ? d.guests : 0);
    }, 0));
    // Interpolate Y value at the "Now" position for label placement
    const slotWidth = (endMins - startMins) / (data.length - 1);
    const floatIdx = (nowMins - startMins) / slotWidth;
    const loIdx = Math.floor(floatIdx);
    const hiIdx = Math.min(loIdx + 1, data.length - 1);
    const frac = floatIdx - loIdx;
    const nowGuests = data[loIdx].guests + (data[hiIdx].guests - data[loIdx].guests) * frac;
    const labelY = yOf(nowGuests);
    // Draw remaining label below the intersection point
    ctx.fillStyle = isDark ? '#E86B5A' : '#993C1D';
    ctx.font = 'bold 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${remaining} left`, nowX, labelY + 14);
  }

  // Peak label
  const peakIdx = data.reduce((best, d, i) => d.guests > data[best].guests ? i : best, 0);
  const peakD = data[peakIdx];
  ctx.fillStyle = lineColor;
  ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`~${Math.round(peakD.guests)}/5min`, xOf(peakIdx), yOf(peakD.guests) - 8);
}
