// AUTH
// ═══════════════════════════════════════════════════════════════════

import { S, setGlobalLocation, restoreGlobalLocation } from './state';
import type { Location } from '@shared/types';
import { showFeedbackFab } from './feedback';
import { disconnectLiveSync } from './utils';
import { initApp, buildNav } from './init';
import { initTelemetry } from './telemetry';

declare const google: any;

// 'login' = normal sign-in (POST /auth/google). 'request' = the "Ask for
// access" button (POST /auth/request-access). The shared Google callback routes
// the returned credential by this flag, then resets it to 'login'.
let authIntent: 'login' | 'request' = 'login';
// Mirrors /api/health.authConfigured — false in dev mode (no GOOGLE_CLIENT_ID),
// where the dev-login button shows and an access request uses the 'dev' token.
let _authConfigured = false;
// First/last name typed into the "Request access" form, sent with the request.
let pendingFirst = '';
let pendingLast = '';

// Google Sign-In callback (global, called by Google SDK)
export function handleGoogleLogin(response: any) {
  const intent = authIntent;
  authIntent = 'login';
  if (intent === 'request') {
    requestAccessWithToken(response.credential);
  } else {
    loginWithToken(response.credential);
  }
}

/** Show the friendly access-request panel (and hide the raw error box).
 *  positive=true for a sent/pending request, false for a denied/revoked one. */
function showAccessMessage(msg: string, positive: boolean) {
  const errEl = document.getElementById('login-error');
  if (errEl) errEl.style.display = 'none';
  const el = document.getElementById('access-msg');
  if (!el) return;
  el.textContent = msg;
  el.className = 'access-msg ' + (positive ? 'access-msg-ok' : 'access-msg-warn');
  el.style.display = 'block';
}

async function loginWithToken(idToken: any) {
  try {
    const res = await fetch('/api/auth/google', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ idToken }),
    });
    const data = await res.json();
    if (!res.ok) {
      // A 403 not_allowed now carries an access-request status — the server has
      // already queued a pending request, so show the friendly waiting message
      // instead of a dead-end error.
      if (res.status === 403 && data.status) {
        showAccessMessage(data.message || 'Toegang aangevraagd.', data.status === 'pending');
      } else {
        const errEl = document.getElementById('login-error')!;
        errEl.textContent = data.message || data.error || 'Login failed';
        errEl.style.display = 'block';
      }
      return;
    }
    S.user = data.user;
    showApp();
  } catch (e: unknown) {
    const errEl = document.getElementById('login-error')!;
    errEl.textContent = 'Could not connect to server';
    errEl.style.display = 'block';
  }
}

async function requestAccessWithToken(idToken: any) {
  try {
    const res = await fetch('/api/auth/request-access', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ idToken, firstName: pendingFirst, lastName: pendingLast }),
    });
    const data = await res.json();
    if (!res.ok) {
      const errEl = document.getElementById('login-error')!;
      errEl.textContent = data.message || data.error || 'Could not request access';
      errEl.style.display = 'block';
      return;
    }
    const denied = data.status === 'denied' || data.status === 'revoked';
    showAccessMessage(data.message || 'Access requested.', !denied);
    // Collapse the form once the request is sent.
    const form = document.getElementById('access-form');
    if (form) form.style.display = 'none';
  } catch (e: unknown) {
    const errEl = document.getElementById('login-error')!;
    errEl.textContent = 'Could not connect to server';
    errEl.style.display = 'block';
  }
}

// "Request access" button — reveal the first/last name form.
export function toggleAccessForm() {
  const form = document.getElementById('access-form');
  if (!form) return;
  const showing = form.style.display !== 'none';
  form.style.display = showing ? 'none' : 'block';
  if (!showing) {
    const fn = document.getElementById('access-firstname') as HTMLInputElement | null;
    if (fn) fn.focus();
  }
}

// Validate the name, then start the request: dev mode posts the 'dev' token
// directly; production kicks off Google sign-in in "request" mode, and the
// shared callback routes the returned credential to /request-access.
export function submitAccessRequest() {
  const fnEl = document.getElementById('access-firstname') as HTMLInputElement | null;
  const lnEl = document.getElementById('access-lastname') as HTMLInputElement | null;
  pendingFirst = fnEl ? fnEl.value.trim() : '';
  pendingLast = lnEl ? lnEl.value.trim() : '';
  const errEl = document.getElementById('login-error')!;
  if (!pendingFirst || !pendingLast) {
    errEl.textContent = 'Please enter your first and last name.';
    errEl.style.display = 'block';
    return;
  }
  errEl.style.display = 'none';
  if (!_authConfigured) {
    requestAccessWithToken('dev');
    return;
  }
  authIntent = 'request';
  try {
    if (typeof google !== 'undefined' && google.accounts) {
      google.accounts.id.prompt((notification: any) => {
        if (notification && (notification.isNotDisplayed?.() || notification.isSkipped?.())) {
          // One Tap can be suppressed by the browser. Fall back to the normal
          // Google button — a sign-in that's not on the allowlist is queued as
          // a request automatically, so the outcome is the same.
          authIntent = 'login';
          showAccessMessage('Use the Google button above to sign in — a new account is requested automatically.', true);
        }
      });
    } else {
      authIntent = 'login';
      showAccessMessage('Use the Google button above to sign in.', true);
    }
  } catch (_e) {
    authIntent = 'login';
  }
}

export async function devLogin() {
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
  } catch (e: unknown) { alert('Could not connect to server'); }
}

export async function doLogout() {
  disconnectLiveSync();
  await fetch('/api/auth/logout', { method: 'POST' });
  S.user = null;
  document.getElementById('app-shell')!.classList.remove('active');
  document.getElementById('login-screen')!.style.display = 'flex';
  // Ensure Google Sign-In button is rendered (may not have been set up
  // if session was valid on page load but expired mid-use)
  initGoogleSignIn();
}

// _googleSignInReady flag (module-level instead of window)
let _googleSignInReady = false;

// Initialize (or re-initialize) the Google Sign-In button on the login screen
export function initGoogleSignIn() {
  if (_googleSignInReady) return; // already set up
  (async () => {
    try {
      const health = await (await fetch('/api/health')).json();
      _authConfigured = !!health.authConfigured;
      if (!health.authConfigured) {
        document.getElementById('dev-login-btn')!.style.display = 'inline-block';
        document.querySelector('.g_id_signin')!.setAttribute('style', 'display:none');
        return;
      }
      let attempts = 0;
      const waitForGoogle = () => {
        if (typeof google !== 'undefined' && google.accounts) {
          google.accounts.id.initialize({
            client_id: health.googleClientId,
            callback: handleGoogleLogin,
          });
          google.accounts.id.renderButton(
            document.querySelector('.g_id_signin'),
            { theme: 'outline', size: 'large', text: 'sign_in_with', shape: 'rectangular', width: 300 }
          );
          _googleSignInReady = true;
        } else if (attempts++ < 50) {
          setTimeout(waitForGoogle, 100);
        } else {
          const errEl = document.getElementById('login-error')!;
          errEl.innerHTML = 'Google Sign-In could not load. Check your internet connection or ad blocker. <button onclick="location.reload()" style="margin-left:8px;cursor:pointer;">Retry</button>';
          errEl.style.display = 'block';
        }
      };
      waitForGoogle();
    } catch (e: unknown) {
      document.getElementById('dev-login-btn')!.style.display = 'inline-block';
      document.querySelector('.g_id_signin')!.setAttribute('style', 'display:none');
    }
  })();
}

export async function checkSession() {
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      const data = await res.json();
      S.user = data.user;
      showApp();
      return true;
    }
  } catch (e: unknown) {}
  return false;
}

export function showApp() {
  document.getElementById('login-screen')!.style.display = 'none';
  document.getElementById('app-shell')!.classList.add('active');
  document.getElementById('bottom-nav')!.classList.add('active');
  // Rebuild the nav now that S.user is known. bootstrap() builds the nav before
  // checkSession() resolves, so on a restored session S.user.isDirector isn't
  // set yet and director-only screens (Team) would be missing. Every login path
  // (fresh login + restored session) funnels through showApp(), so rebuilding
  // here covers them all. selectLocation() rebuilds again after the location
  // chooser, which is fine — both run with S.user populated.
  buildNav();
  // Update user menu
  document.getElementById('user-name')!.textContent = S.user?.name || '';
  if (S.user?.picture) {
    const img = document.getElementById('user-avatar') as HTMLImageElement;
    img.src = S.user.picture;
    img.style.display = 'block';
  }
  initTelemetry(S.user?.email);

  // If no saved location, show location chooser before entering the app
  if (!restoreGlobalLocation()) {
    showLocationChooser();
    return;
  }

  initApp();
  if (typeof showFeedbackFab === 'function') showFeedbackFab();
}

export function showLocationChooser() {
  const content = document.getElementById('content')!;
  content.innerHTML = `
    <div class="location-chooser">
      <div class="location-chooser-card">
        <h2>Welke locatie?</h2>
        <p>In welke keuken werk je vandaag?</p>
        <div class="location-chooser-buttons">
          <button onclick="selectLocation('west')" class="loc-choose-btn loc-choose-west" data-testid="loc-choose-west">
            <span class="loc-choose-icon">W</span>
            <span class="loc-choose-label">Sering West</span>
          </button>
          <button onclick="selectLocation('centraal')" class="loc-choose-btn loc-choose-centraal" data-testid="loc-choose-centraal">
            <span class="loc-choose-icon">C</span>
            <span class="loc-choose-label">Sering Centraal</span>
          </button>
        </div>
      </div>
    </div>
  `;
}

export function selectLocation(loc: Location) {
  setGlobalLocation(loc);
  // Rebuild nav because showLocationChooser() replaced the screen containers
  buildNav();
  // Re-populate user menu after nav rebuild
  document.getElementById('user-name')!.textContent = S.user?.name || '';
  if (S.user?.picture) {
    const img = document.getElementById('user-avatar') as HTMLImageElement;
    img.src = S.user.picture;
    img.style.display = 'block';
  }
  initApp();
  if (typeof showFeedbackFab === 'function') showFeedbackFab();
}

// ═══════════════════════════════════════════════════════════════════
