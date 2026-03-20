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

// ═══════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════

async function initApp() {
  await loadData();
  rebuildPlanner();
  renderDashboard();
}

// On page load: check for existing session, or show login
(async () => {
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
