// SCREENS
// ═══════════════════════════════════════════════════════════════════

function showScreen(name, btn) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('screen-' + name).classList.add('active');
  btn.classList.add('active');
  rebuildPlanner();
  if (name === 'dashboard') renderDashboard();
  if (name === 'guests') renderGuests();
  if (name === 'planner') renderWeekPlan();
  if (name === 'recipe-index') renderRecipeIndex();
  if (name === 'orders') renderOrders();
}

// ── DASHBOARD ────────────────────────────────────────────
function getTodayIndex() {
  return (new Date().getDay() + 6) % 7; // 0=Mon ... 6=Sun
}

function renderDashboard() {
  const todayIdx = getTodayIndex();
  const todayName = DAYS[todayIdx];
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long' });

  // Greeting based on time of day
  const hour = now.getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const userName = S.user?.name ? ', ' + S.user.name.split(' ')[0] : '';

  // Today's dishes per location and meal
  const locations = [
    { key:'west', label:'Sering West' },
    { key:'centraal', label:'Sering Centraal' }
  ];

  // Build today's service overview
  let servingHtml = '';
  locations.forEach(loc => {
    servingHtml += `<div class="dash-loc-section"><div class="dash-loc-label">${loc.label}</div>`;
    MEALS.forEach(meal => {
      const k = `${loc.key}-${todayIdx}-${meal}`;
      const slotDishes = S.planner[k] || [];
      const gc = getGuests(loc.key, todayIdx, meal);
      servingHtml += `<div class="dash-meal-row">
        <div class="dash-meal-label">${meal}</div>
        <div class="dash-meal-dishes">`;
      if (slotDishes.length === 0) {
        servingHtml += `<span class="dash-meal-empty">No dishes planned${gc > 0 ? ' (' + gc + ' guests expected)' : ''}</span>`;
      } else {
        slotDishes.forEach(d => {
          const { cls } = diffStr(d);
          servingHtml += `<div class="dish-chip ${chipClass(d)}" style="cursor:pointer;" onclick="navTo('planner','overview')">
            <span class="chip-nm">${esc(d.name)}</span>
          </div>`;
        });
        servingHtml += `<span style="font-size:11px;color:var(--text3);align-self:center;margin-left:2px;">${gc} guests</span>`;
      }
      servingHtml += `</div></div>`;
    });
    servingHtml += '</div>';
  });

  // Guest count summary for today
  let totalLunch = 0, totalDinner = 0;
  locations.forEach(loc => {
    totalLunch += getGuests(loc.key, todayIdx, 'lunch');
    totalDinner += getGuests(loc.key, todayIdx, 'dinner');
  });

  // Stock alerts — dishes with shortfalls
  const shortfalls = S.dishes.filter(d => {
    const req = calcRequired(d);
    return req > 0 && d.stock < req;
  });

  let alertHtml = '';
  if (shortfalls.length === 0) {
    alertHtml = `<div class="dash-ok"><div class="dash-ok-dot"></div> All dishes have sufficient stock for this week</div>`;
  } else {
    shortfalls.slice(0, 5).forEach(d => {
      const req = calcRequired(d);
      const { str } = diffStr(d);
      alertHtml += `<div class="dash-alert">
        <div class="dash-alert-name">${esc(d.name)} <span style="font-weight:400;color:var(--text2);font-size:11px;">${d.logistics}</span></div>
        <div class="dash-alert-detail">${str} (need ${req}L, have ${d.stock}L)</div>
      </div>`;
    });
    if (shortfalls.length > 5) {
      alertHtml += `<div style="font-size:12px;color:var(--text2);padding:6px 0;">+ ${shortfalls.length - 5} more &mdash; <a href="#" onclick="event.preventDefault();navTo('planner','overview')" style="color:var(--blue);">view all</a></div>`;
    }
  }

  // Week overview — how many dishes per day
  let weekHtml = '<div style="display:flex;gap:4px;">';
  DAYS.forEach((day, idx) => {
    let count = 0;
    locations.forEach(loc => {
      MEALS.forEach(meal => {
        count += (S.planner[`${loc.key}-${idx}-${meal}`] || []).length;
      });
    });
    const isToday = idx === todayIdx;
    weekHtml += `<div style="flex:1;text-align:center;padding:8px 4px;border-radius:var(--radius);${isToday ? 'background:var(--text);color:var(--bg);font-weight:600;' : 'background:var(--bg2);color:var(--text2);'}">
      <div style="font-size:11px;font-weight:600;">${day}</div>
      <div style="font-size:16px;font-weight:600;margin-top:2px;">${count}</div>
      <div style="font-size:10px;opacity:.7;">${count === 1 ? 'dish' : 'dishes'}</div>
    </div>`;
  });
  weekHtml += '</div>';

  // Dishes that need ordering
  const orderDishes = S.dishes.filter(d => d.orderFor);

  document.getElementById('screen-dashboard').innerHTML = `
    <div class="dash-greeting">${greeting}${esc(userName)}</div>
    <div class="dash-date">${dateStr} &mdash; ${S.dishes.length} dishes in planner</div>

    <div class="dash-grid">
      <div class="dash-card">
        <div class="dash-card-title">
          <div class="dash-icon" style="background:var(--blue-bg);color:var(--blue);">&#9734;</div>
          Today's menu
        </div>
        ${servingHtml}
      </div>

      <div class="dash-card">
        <div class="dash-card-title">
          <div class="dash-icon" style="background:var(--green-bg);color:var(--green);">&#9829;</div>
          Today's guests
        </div>
        <div class="dash-guest-grid">
          <div class="dash-guest-box">
            <div class="dash-guest-num">${totalLunch}</div>
            <div class="dash-guest-label">Lunch</div>
          </div>
          <div class="dash-guest-box">
            <div class="dash-guest-num">${totalDinner}</div>
            <div class="dash-guest-label">Dinner</div>
          </div>
        </div>
        <div style="margin-top:10px;">
          ${locations.map(loc => `<div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text2);padding:3px 0;">
            <span>${loc.label}</span>
            <span>${getGuests(loc.key, todayIdx, 'lunch')}L / ${getGuests(loc.key, todayIdx, 'dinner')}D</span>
          </div>`).join('')}
        </div>
      </div>

      <div class="dash-card dash-full-width">
        <div class="dash-card-title">
          <div class="dash-icon" style="background:${shortfalls.length ? 'var(--red-bg);color:var(--red)' : 'var(--green-bg);color:var(--green)'};">${shortfalls.length ? '!' : '&#10003;'}</div>
          Stock alerts${shortfalls.length ? ' (' + shortfalls.length + ')' : ''}
        </div>
        ${alertHtml}
      </div>

      <div class="dash-card dash-full-width">
        <div class="dash-card-title">
          <div class="dash-icon" style="background:var(--purple-bg);color:var(--purple);">&#9632;</div>
          Week at a glance
        </div>
        ${weekHtml}
      </div>
    </div>

    <div class="dash-actions">
      <div class="dash-action-btn" onclick="navTo('planner')">&#8594; Week plan</div>
      <div class="dash-action-btn" onclick="navTo('planner','overview')">&#43; Dishes</div>
      <div class="dash-action-btn" onclick="navTo('orders')">&#128203; Orders${orderDishes.length ? ' (' + orderDishes.length + ')' : ''}</div>
      <div class="dash-action-btn" onclick="navTo('guests')">&#9998; Guests</div>
    </div>
  `;
}

function navTo(screen, subTab) {
  const btns = document.querySelectorAll('.nav-btn');
  const labels = { dashboard:'Dashboard', guests:'Guests', planner:'Week plan', 'recipe-index':'Recipes', orders:'Orders' };
  if (subTab) S.plannerSubTab = subTab;
  btns.forEach(b => { if (b.textContent === labels[screen]) showScreen(screen, b); });
}
