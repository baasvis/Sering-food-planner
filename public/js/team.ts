// ─────────────────────────────────────────────────────────────────────────────
// TEAM — director-only screen for reviewing account-access requests and
// managing who can use the planner.
//
// Pending requests can be approved / denied; approved people can be revoked.
// The env allowlist (ALLOWED_EMAILS) is shown read-only as "always allowed" so
// the list is complete and a director can't lock themselves out from the UI.
// Data + actions are director-gated server-side (routes/access.ts) — this
// screen is also hidden from non-directors in buildNav (defence in depth).
// ─────────────────────────────────────────────────────────────────────────────

import type { AccessRequestDTO } from '@shared/types';
import { apiGet, apiPost, toast, toastError } from './utils';
import { registerRenderer } from './navigate';
import { esc, showModal, closeModal } from './modal';

interface TeamData { requests: AccessRequestDTO[]; envEmails: string[]; }
let _data: TeamData | null = null;

export function renderTeam(): void {
  const el = document.getElementById('screen-team');
  if (!el) return; // non-director: container isn't built (and the API 403s too)
  if (!_data) {
    el.innerHTML = `<div class="team-screen"><h2>Team &amp; access</h2><p class="team-loading">Loading…</p></div>`;
  }
  void loadTeam();
}

async function loadTeam(): Promise<void> {
  const el = document.getElementById('screen-team');
  if (!el) return;
  try {
    _data = await apiGet('/api/access/requests');
  } catch (e: unknown) {
    el.innerHTML = `<div class="team-screen"><h2>Team &amp; access</h2><p class="team-error">Could not load access requests.</p></div>`;
    return;
  }
  paintTeam();
}

function avatar(r: AccessRequestDTO): string {
  if (r.picture) return `<img class="team-avatar" src="${esc(r.picture)}" alt="" referrerpolicy="no-referrer">`;
  const initial = (r.name || r.email || '?').trim().charAt(0).toUpperCase();
  return `<span class="team-avatar team-avatar-fallback">${esc(initial)}</span>`;
}

function when(iso: string): string {
  try { return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); }
  catch (_e) { return ''; }
}

function personRow(r: AccessRequestDTO, actions: string, extraClass = ''): string {
  return `
    <div class="team-row ${extraClass}" data-id="${esc(r.id)}">
      ${avatar(r)}
      <div class="team-person">
        <div class="team-name">${esc(r.name || r.email)}</div>
        <div class="team-email">${esc(r.email)}</div>
      </div>
      <div class="team-actions">
        <button class="team-btn team-btn-edit" onclick="editAccessName('${esc(r.id)}')" title="Edit name">Edit</button>
        ${actions}
      </div>
    </div>`;
}

function paintTeam(): void {
  const el = document.getElementById('screen-team');
  if (!el || !_data) return;
  const reqs = _data.requests || [];
  const pending = reqs.filter(r => r.status === 'pending');
  const approved = reqs.filter(r => r.status === 'approved');
  const closed = reqs.filter(r => r.status === 'denied' || r.status === 'revoked');
  const env = _data.envEmails || [];

  const pendingHtml = pending.length
    ? pending.map(r => personRow(r, `
        <span class="team-when">${when(r.requestedAt)}</span>
        <button class="team-btn team-btn-approve" onclick="approveAccess('${esc(r.id)}')">Approve</button>
        <button class="team-btn team-btn-deny" onclick="denyAccess('${esc(r.id)}')">Deny</button>`)).join('')
    : `<p class="team-empty">No pending requests.</p>`;

  const approvedHtml = approved.length
    ? approved.map(r => personRow(r, `<button class="team-btn team-btn-revoke" onclick="revokeAccess('${esc(r.id)}')">Revoke access</button>`)).join('')
    : `<p class="team-empty">No one approved in the app yet.</p>`;

  const closedHtml = closed.length
    ? `<details class="team-fold"><summary>Denied / revoked (${closed.length})</summary>${
        closed.map(r => personRow(r, `<button class="team-btn team-btn-approve" onclick="approveAccess('${esc(r.id)}')">Approve anyway</button>`, 'team-row-muted')).join('')
      }</details>`
    : '';

  const envHtml = env.length
    ? `<details class="team-fold"><summary>Always allowed — configured in env (${env.length})</summary>${
        env.map(e => `<div class="team-row team-row-muted"><span class="team-avatar team-avatar-fallback">${esc(e.charAt(0).toUpperCase())}</span><div class="team-person"><div class="team-email">${esc(e)}</div></div><span class="team-env-tag">env</span></div>`).join('')
      }</details>`
    : '';

  el.innerHTML = `
    <div class="team-screen">
      <h2>Team &amp; access</h2>
      <p class="team-intro">Approve people who asked to use the planner, and manage who has access.</p>

      <section class="team-section">
        <h3>Waiting for approval${pending.length ? ` <span class="team-count">${pending.length}</span>` : ''}</h3>
        ${pendingHtml}
      </section>

      <section class="team-section">
        <h3>Approved in the app</h3>
        ${approvedHtml}
      </section>

      ${closedHtml ? `<section class="team-section">${closedHtml}</section>` : ''}
      ${envHtml ? `<section class="team-section">${envHtml}</section>` : ''}
    </div>`;
}

async function decide(id: string, action: 'approve' | 'deny' | 'revoke', okMsg: string): Promise<void> {
  try {
    await apiPost(`/api/access/requests/${id}/${action}`, {});
    toast(okMsg);
    await loadTeam();
  } catch (e: unknown) {
    toastError('Action failed');
  }
}

export function approveAccess(id: string): void { void decide(id, 'approve', 'Approved'); }
export function denyAccess(id: string): void { void decide(id, 'deny', 'Denied'); }
export function revokeAccess(id: string): void { void decide(id, 'revoke', 'Access revoked'); }

// Edit a person's first/last name. Prefills from the stored firstName/lastName,
// falling back to splitting the display name for older rows that only have one.
export function editAccessName(id: string): void {
  const r = _data?.requests.find(x => x.id === id);
  if (!r) { toast('That request is no longer in the list'); return; }
  const parts = (r.name || '').trim().split(/\s+/).filter(Boolean);
  const first = r.firstName ?? (parts.length > 1 ? parts.slice(0, -1).join(' ') : (parts[0] || ''));
  const last = r.lastName ?? (parts.length > 1 ? parts[parts.length - 1] : '');
  showModal(`
    <div data-testid="access-rename-modal">
      <h3>Edit name</h3>
      <div class="modal-note">${esc(r.email)}</div>
      <div class="fr"><label for="access-edit-first">First name</label><input type="text" id="access-edit-first" value="${esc(first)}" autocomplete="off"></div>
      <div class="fr"><label for="access-edit-last">Last name</label><input type="text" id="access-edit-last" value="${esc(last)}" autocomplete="off"></div>
      <div class="modal-actions">
        <button class="btn" onclick="closeModal()">Cancel</button>
        <button class="btn btn-purple" onclick="saveAccessName('${esc(id)}')">Save</button>
      </div>
    </div>
  `);
  setTimeout(() => { const i = document.getElementById('access-edit-first') as HTMLInputElement | null; if (i) { i.focus(); i.select(); } }, 50);
}

export async function saveAccessName(id: string): Promise<void> {
  const fnEl = document.getElementById('access-edit-first') as HTMLInputElement | null;
  const lnEl = document.getElementById('access-edit-last') as HTMLInputElement | null;
  const firstName = fnEl ? fnEl.value.trim() : '';
  const lastName = lnEl ? lnEl.value.trim() : '';
  if (!firstName || !lastName) { toast('Enter a first and last name'); return; }
  try {
    await apiPost(`/api/access/requests/${id}`, { firstName, lastName }, 'PATCH');
    closeModal();
    toast('Name updated');
    await loadTeam();
  } catch (e: unknown) {
    toast('Could not save: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}

registerRenderer('team', renderTeam);
