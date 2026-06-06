// ─────────────────────────────────────────────────────────────────────────────
// TEAM — director-only screen for account-access requests AND role-based page
// permissions.
//
// Top: review/approve/deny/revoke requests, edit names, assign each user a role.
// Bottom: define roles, each mapping every gateable screen to hidden/view/edit.
// Permissions are a frontend guardrail (see public/js/navigate.ts + utils.ts
// apiPost) — directors always have full access. Data + actions are
// director-gated server-side (routes/access.ts); this screen is also hidden
// from non-directors in buildNav.
// ─────────────────────────────────────────────────────────────────────────────

import type { AccessRequestDTO, RoleDTO, PagePermission } from '@shared/types';
import { NAV_SCREENS } from './state';
import { apiGet, apiPost, toast } from './utils';
import { registerRenderer } from './navigate';
import { esc, showModal, closeModal } from './modal';

interface TeamData { requests: AccessRequestDTO[]; envEmails: string[]; }
let _data: TeamData | null = null;
let _roles: RoleDTO[] = [];
let _screens: string[] = [];

const LEVELS: PagePermission[] = ['hidden', 'view', 'edit'];
const LEVEL_LABEL: Record<PagePermission, string> = { hidden: 'Hidden', view: 'View', edit: 'Edit' };

function screenLabel(id: string): string {
  const nav = (NAV_SCREENS as Array<{ id: string; topLabel: string }>).find(s => s.id === id);
  return nav ? nav.topLabel : id;
}

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
    const [access, rolesRes] = await Promise.all([
      apiGet('/api/access/requests'),
      apiGet('/api/access/roles'),
    ]);
    _data = access;
    _roles = rolesRes.roles || [];
    _screens = rolesRes.screens || [];
  } catch (e: unknown) {
    el.innerHTML = `<div class="team-screen"><h2>Team &amp; access</h2><p class="team-error">Could not load the team page.</p></div>`;
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

/** Role <select>. For approved users it saves on change (withHandler); for
 *  pending rows it's just a pre-pick (default role) the Approve action reads. */
function roleSelect(r: AccessRequestDTO, withHandler: boolean, selectedId: string | null): string {
  const opts = [`<option value="" ${!selectedId ? 'selected' : ''}>No role — full access</option>`]
    .concat(_roles.map(role => `<option value="${esc(role.id)}" ${role.id === selectedId ? 'selected' : ''}>${esc(role.name)}</option>`))
    .join('');
  const handler = withHandler ? ` onchange="assignUserRole('${esc(r.id)}', this.value)"` : '';
  return `<select class="role-select"${handler} title="Role">${opts}</select>`;
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

function roleCard(role: RoleDTO): string {
  const counts = LEVELS.map(l => `${_screens.filter(s => (role.permissions[s] || 'view') === l).length} ${l}`).join(' · ');
  const rows = _screens.map(s => {
    const cur = (role.permissions[s] as PagePermission) || 'view';
    const btns = LEVELS.map(l =>
      `<button class="rm-lvl rm-${l}${cur === l ? ' on' : ''}" onclick="roleSetLevel('${esc(role.id)}','${esc(s)}','${l}')">${LEVEL_LABEL[l]}</button>`
    ).join('');
    return `<div class="role-matrix-row"><span class="rm-screen">${esc(screenLabel(s))}</span><div class="rm-levels">${btns}</div></div>`;
  }).join('');
  return `
    <details class="role-card" data-role="${esc(role.id)}">
      <summary>
        <span class="role-name">${esc(role.name)}</span>
        ${role.isDefault ? '<span class="role-default-badge">default</span>' : ''}
        <span class="role-summary">${counts}</span>
      </summary>
      <div class="role-matrix">${rows}</div>
      <div class="role-card-actions">
        ${role.isDefault ? '' : `<button class="team-btn" onclick="roleSetDefault('${esc(role.id)}')">Make default</button>`}
        <button class="team-btn" onclick="duplicateRole('${esc(role.id)}')">Duplicate</button>
        <button class="team-btn" onclick="roleRename('${esc(role.id)}')">Rename</button>
        <button class="team-btn team-btn-deny" onclick="roleDelete('${esc(role.id)}')">Delete</button>
      </div>
    </details>`;
}

function paintTeam(): void {
  const el = document.getElementById('screen-team');
  if (!el || !_data) return;
  const reqs = _data.requests || [];
  const pending = reqs.filter(r => r.status === 'pending');
  const approved = reqs.filter(r => r.status === 'approved');
  const closed = reqs.filter(r => r.status === 'denied' || r.status === 'revoked');
  const env = _data.envEmails || [];
  const defaultRoleId = _roles.find(r => r.isDefault)?.id ?? null;

  const pendingHtml = pending.length
    ? pending.map(r => personRow(r, `
        <span class="team-when">${when(r.requestedAt)}</span>
        ${roleSelect(r, false, defaultRoleId)}
        <button class="team-btn team-btn-approve" onclick="approveAccess('${esc(r.id)}')">Approve</button>
        <button class="team-btn team-btn-deny" onclick="denyAccess('${esc(r.id)}')">Deny</button>`)).join('')
    : `<p class="team-empty">No pending requests.</p>`;

  const approvedHtml = approved.length
    ? approved.map(r => personRow(r, `${roleSelect(r, true, r.roleId)}<button class="team-btn team-btn-revoke" onclick="revokeAccess('${esc(r.id)}')">Revoke</button>`)).join('')
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

  const rolesHtml = _roles.length
    ? _roles.map(roleCard).join('')
    : `<p class="team-empty">No roles yet.</p>`;

  el.innerHTML = `
    <div class="team-screen">
      <h2>Team &amp; access</h2>
      <p class="team-intro">Approve people who asked to use the planner, manage who has access, and set what each role can see and edit.</p>

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

      <section class="team-section">
        <h3>Roles &amp; page access</h3>
        <p class="team-intro">Each role sets, per page, whether members can <strong>edit</strong>, only <strong>view</strong>, or not see it (<strong>hidden</strong>). Directors always have full access. Changes apply to a user the next time they open the app.</p>
        <div class="roles-list">${rolesHtml}</div>
        <button class="team-btn" onclick="roleCreate()">+ New role</button>
      </section>
    </div>`;
}

async function decide(id: string, action: 'approve' | 'deny' | 'revoke', okMsg: string, body: Record<string, unknown> = {}): Promise<void> {
  try {
    await apiPost(`/api/access/requests/${id}/${action}`, body);
    toast(okMsg);
    await loadTeam();
  } catch (e: unknown) {
    toast('Action failed');
  }
}

export function approveAccess(id: string): void {
  // Approve with the role pre-picked in this pending row (empty = the default).
  const sel = document.querySelector(`#screen-team .team-row[data-id="${id}"] .role-select`) as HTMLSelectElement | null;
  void decide(id, 'approve', 'Approved', { roleId: sel && sel.value ? sel.value : null });
}
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

// ── Roles ────────────────────────────────────────────────────────────────────

export async function assignUserRole(reqId: string, roleId: string): Promise<void> {
  try {
    await apiPost(`/api/access/requests/${reqId}/role`, { roleId: roleId || null }, 'PATCH');
    toast('Role updated');
    await loadTeam();
  } catch (e: unknown) {
    toast('Could not change role');
  }
}

export async function roleSetLevel(roleId: string, screen: string, level: string): Promise<void> {
  const role = _roles.find(r => r.id === roleId);
  if (!role) return;
  const permissions = { ...role.permissions, [screen]: level as PagePermission };
  try {
    await apiPost(`/api/access/roles/${roleId}`, { permissions }, 'PATCH');
    await loadTeam();
  } catch (e: unknown) {
    toast('Could not update role');
  }
}

export async function roleSetDefault(roleId: string): Promise<void> {
  try {
    await apiPost(`/api/access/roles/${roleId}`, { isDefault: true }, 'PATCH');
    toast('Default role set');
    await loadTeam();
  } catch (e: unknown) {
    toast('Could not set default');
  }
}

export function roleCreate(): void {
  showModal(`
    <div data-testid="role-create-modal">
      <h3>New role</h3>
      <div class="modal-note">New roles start with every page set to "view" — adjust after creating.</div>
      <div class="fr"><label for="role-new-name">Role name</label><input type="text" id="role-new-name" placeholder="e.g. Cook, FOH, Manager" autocomplete="off"></div>
      <div class="modal-actions">
        <button class="btn" onclick="closeModal()">Cancel</button>
        <button class="btn btn-purple" onclick="saveNewRole()">Create</button>
      </div>
    </div>
  `);
  setTimeout(() => { const i = document.getElementById('role-new-name') as HTMLInputElement | null; if (i) i.focus(); }, 50);
}

export async function saveNewRole(): Promise<void> {
  const input = document.getElementById('role-new-name') as HTMLInputElement | null;
  const name = input ? input.value.trim() : '';
  if (!name) { toast('Enter a role name'); return; }
  try {
    await apiPost('/api/access/roles', { name }, 'POST');
    closeModal();
    toast(`Created ${name}`);
    await loadTeam();
  } catch (e: unknown) {
    toast('Could not create role');
  }
}

export function roleRename(roleId: string): void {
  const role = _roles.find(r => r.id === roleId);
  if (!role) return;
  showModal(`
    <div data-testid="role-rename-modal">
      <h3>Rename role</h3>
      <div class="fr"><label for="role-rename-name">Role name</label><input type="text" id="role-rename-name" value="${esc(role.name)}" autocomplete="off"></div>
      <div class="modal-actions">
        <button class="btn" onclick="closeModal()">Cancel</button>
        <button class="btn btn-purple" onclick="saveRoleName('${esc(roleId)}')">Save</button>
      </div>
    </div>
  `);
  setTimeout(() => { const i = document.getElementById('role-rename-name') as HTMLInputElement | null; if (i) { i.focus(); i.select(); } }, 50);
}

export async function saveRoleName(roleId: string): Promise<void> {
  const input = document.getElementById('role-rename-name') as HTMLInputElement | null;
  const name = input ? input.value.trim() : '';
  if (!name) { toast('Enter a role name'); return; }
  try {
    await apiPost(`/api/access/roles/${roleId}`, { name }, 'PATCH');
    closeModal();
    toast('Role renamed');
    await loadTeam();
  } catch (e: unknown) {
    toast('Could not rename role');
  }
}

export function roleDelete(roleId: string): void {
  const role = _roles.find(r => r.id === roleId);
  if (!role) return;
  showModal(`
    <div data-testid="role-delete-modal">
      <h3>Delete role "${esc(role.name)}"?</h3>
      <div class="modal-note">You can only delete a role no one is assigned to. Members keep their current access until reassigned.</div>
      <div class="modal-actions">
        <button class="btn" onclick="closeModal()">Cancel</button>
        <button class="btn btn-danger" onclick="confirmRoleDelete('${esc(roleId)}')">Delete</button>
      </div>
    </div>
  `);
}

export async function confirmRoleDelete(roleId: string): Promise<void> {
  try {
    await apiPost(`/api/access/roles/${roleId}`, {}, 'DELETE');
    closeModal();
    toast('Role deleted');
    await loadTeam();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '';
    closeModal();
    toast(/in_use|in use/i.test(msg) ? 'That role is still assigned to someone — reassign them first.' : 'Could not delete role');
  }
}

export async function duplicateRole(roleId: string): Promise<void> {
  const role = _roles.find(r => r.id === roleId);
  if (!role) return;
  try {
    await apiPost('/api/access/roles', { name: `${role.name} copy`, permissions: role.permissions }, 'POST');
    toast('Role duplicated');
    await loadTeam();
  } catch (e: unknown) {
    toast('Could not duplicate role');
  }
}

registerRenderer('team', renderTeam);
