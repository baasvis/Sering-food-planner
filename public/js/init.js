// ── MODAL ─────────────────────────────────────────────────
function showModal(content) {
  document.getElementById('modal-root').innerHTML = `<div class="modal-bg" onclick="closeModal()"><div class="modal" onclick="event.stopPropagation()">${content}</div></div>`;
}
function closeModal() {
  document.getElementById('modal-root').innerHTML = '';
  // Reopen inventory if we came from served dialog
  if (S._inventoryLoc) {
    const loc = S._inventoryLoc;
    S._inventoryLoc = null;
    setTimeout(() => openInventory(loc), 200);
  }
}

// ── HTML ESCAPE ───────────────────────────────────────────
function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── NAV GENERATION ────────────────────────────────────────
// Builds top bar, bottom nav, and screen containers from NAV_SCREENS
function buildNav() {
  const topBar = document.getElementById('top-bar');
  const content = document.getElementById('content');
  const bottomNav = document.getElementById('bottom-nav');

  // Top bar: title + nav buttons + save indicator + user menu
  topBar.innerHTML = `
    <h1>De Sering</h1>
    ${NAV_SCREENS.map((s, i) =>
      `<button class="nav-btn${i === 0 ? ' active' : ''}" data-screen="${s.id}" onclick="showScreen('${s.id}')">${s.topLabel}</button>`
    ).join('')}
    <div class="save-indicator" id="save-indicator">
      <div class="save-dot saved" id="save-dot"></div>
      <span id="save-text">Saved</span>
    </div>
    <div class="user-menu" id="user-menu">
      <img id="user-avatar" src="" alt="" style="display:none;">
      <span id="user-name"></span>
      <button onclick="doLogout()">Logout</button>
    </div>
  `;

  // Screen containers
  content.innerHTML = NAV_SCREENS.map((s, i) =>
    `<div id="screen-${s.id}" class="screen${i === 0 ? ' active' : ''}"></div>`
  ).join('');

  // Bottom nav
  bottomNav.innerHTML = NAV_SCREENS.map((s, i) =>
    `<button class="bnav-btn${i === 0 ? ' active' : ''}" data-screen="${s.id}" onclick="showScreen('${s.id}')">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${s.icon}</svg>
      <span>${s.bottomLabel}</span>
    </button>`
  ).join('');
}

// ── BEFOREUNLOAD GUARD ────────────────────────────────────
window.addEventListener('beforeunload', function(e) {
  if (saveState !== 'saved') {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ═══════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════

async function initApp() {
  await loadData();
  rebuildPlanner();
  renderDashboard();
  // Auto-refresh every 60s so the UI updates when a service deadline passes (13:45 / 20:15)
  // Only rebuild planner data silently; re-render only non-dashboard views to avoid flash
  setInterval(() => {
    rebuildPlanner();
    const active = document.querySelector('.screen.active');
    if (active && active.id !== 'screen-dashboard') {
      const scrollY = window.scrollY;
      rerenderCurrentView();
      requestAnimationFrame(() => window.scrollTo(0, scrollY));
    }
  }, 60000);
}

// On page load: build nav, then check for existing session or show login
(async () => {
  buildNav();

  const hasSession = await checkSession();
  if (!hasSession) {
    try {
      const health = await (await fetch('/api/health')).json();
      if (!health.authConfigured) {
        // Dev mode: show dev login button, hide Google button
        document.getElementById('dev-login-btn').style.display = 'inline-block';
        document.querySelector('.g_id_signin').style.display = 'none';
      } else {
        // Initialize Google Sign-In with the client ID from server
        const waitForGoogle = () => {
          if (window.google && google.accounts) {
            google.accounts.id.initialize({
              client_id: health.googleClientId,
              callback: handleGoogleLogin,
            });
            google.accounts.id.renderButton(
              document.querySelector('.g_id_signin'),
              { theme: 'outline', size: 'large', text: 'sign_in_with', shape: 'rectangular', width: 300 }
            );
          } else {
            setTimeout(waitForGoogle, 100);
          }
        };
        waitForGoogle();
      }
    } catch (e) {
      document.getElementById('dev-login-btn').style.display = 'inline-block';
      document.querySelector('.g_id_signin').style.display = 'none';
    }
  }
})();
