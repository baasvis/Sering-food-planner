// AUTH
// ═══════════════════════════════════════════════════════════════════

// Google Sign-In callback (global, called by Google SDK)
function handleGoogleLogin(response) {
  loginWithToken(response.credential);
}

async function loginWithToken(idToken) {
  try {
    const res = await fetch('/api/auth/google', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ idToken }),
    });
    const data = await res.json();
    if (!res.ok) {
      const errEl = document.getElementById('login-error');
      errEl.textContent = data.message || data.error || 'Login failed';
      errEl.style.display = 'block';
      return;
    }
    S.user = data.user;
    showApp();
  } catch (e) {
    const errEl = document.getElementById('login-error');
    errEl.textContent = 'Could not connect to server';
    errEl.style.display = 'block';
  }
}

async function devLogin() {
  // For dev mode when no Google Client ID is configured
  try {
    const res = await fetch('/api/auth/google', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ idToken: 'dev' }),
    });
    const data = await res.json();
    S.user = data.user;
    showApp();
  } catch (e) { alert('Could not connect to server'); }
}

async function doLogout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  S.user = null;
  document.getElementById('app-shell').classList.remove('active');
  document.getElementById('login-screen').style.display = 'flex';
}

async function checkSession() {
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      const data = await res.json();
      S.user = data.user;
      showApp();
      return true;
    }
  } catch (e) {}
  return false;
}

function showApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app-shell').classList.add('active');
  // Update user menu
  document.getElementById('user-name').textContent = S.user?.name || '';
  if (S.user?.picture) {
    const img = document.getElementById('user-avatar');
    img.src = S.user.picture;
    img.style.display = 'block';
  }
  initApp();
}

// ═══════════════════════════════════════════════════════════════════
