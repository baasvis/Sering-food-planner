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
  disconnectLiveSync();
  await fetch('/api/auth/logout', { method: 'POST' });
  S.user = null;
  document.getElementById('app-shell').classList.remove('active');
  document.getElementById('login-screen').style.display = 'flex';
  // Ensure Google Sign-In button is rendered (may not have been set up
  // if session was valid on page load but expired mid-use)
  initGoogleSignIn();
}

// Initialize (or re-initialize) the Google Sign-In button on the login screen
function initGoogleSignIn() {
  if (window._googleSignInReady) return; // already set up
  (async () => {
    try {
      const health = await (await fetch('/api/health')).json();
      if (!health.authConfigured) {
        document.getElementById('dev-login-btn').style.display = 'inline-block';
        document.querySelector('.g_id_signin').style.display = 'none';
        return;
      }
      let attempts = 0;
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
          window._googleSignInReady = true;
        } else if (attempts++ < 50) {
          setTimeout(waitForGoogle, 100);
        } else {
          const errEl = document.getElementById('login-error');
          errEl.innerHTML = 'Google Sign-In could not load. Check your internet connection or ad blocker. <button onclick="location.reload()" style="margin-left:8px;cursor:pointer;">Retry</button>';
          errEl.style.display = 'block';
        }
      };
      waitForGoogle();
    } catch (e) {
      document.getElementById('dev-login-btn').style.display = 'inline-block';
      document.querySelector('.g_id_signin').style.display = 'none';
    }
  })();
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
  document.getElementById('bottom-nav').classList.add('active');
  // Update user menu
  document.getElementById('user-name').textContent = S.user?.name || '';
  if (S.user?.picture) {
    const img = document.getElementById('user-avatar');
    img.src = S.user.picture;
    img.style.display = 'block';
  }
  initApp();
  if (typeof showFeedbackFab === 'function') showFeedbackFab();
}

// ═══════════════════════════════════════════════════════════════════
