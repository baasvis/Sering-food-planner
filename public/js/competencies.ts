// ─────────────────────────────────────────────────────────────────────────────
// COMPETENCIES — peer-teaching tracker (frontend).
//
// The home view is the people × chunks grid. Each cell shows when that person
// was last taught that chunk, shaded by recency. Tapping a cell opens the log
// modal (learner + chunk pre-filled — pick the teacher, save). The public
// ledger of recent teachings sits beneath the grid.
// ─────────────────────────────────────────────────────────────────────────────

import { apiGet, apiPost, toast, todayIso, newId } from './utils';
import { showModal, closeModal, esc } from './modal';
import { registerRenderer } from './navigate';

interface CChunk {
  id: string; name: string; station: string; type: string;
  goal: string; prerequisites: string[]; requiredFor: string[];
  deeperLink: string | null; teachingGuide: string; sortOrder: number;
}
interface CPerson { id: string; name: string; location: string; active: boolean; }
interface CEvent {
  id: string; chunkId: string; teacherId: string; learnerId: string;
  date: string; notes: string; createdAt: string;
  createdByEmail: string; createdByName: string;
}

let cChunks: CChunk[] = [];
let cPeople: CPerson[] = [];
let cEvents: CEvent[] = [];
let cStationFilter = 'all';
let cLoaded = false;

// Log modal: the cell tap pre-fills learner + chunk; the teacher is picked
// inside the modal. Held at module scope so submitCompLog can read it.
let logLearnerId = '';
let logChunkId = '';
let logTeacherId = '';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ── Helpers ──

function fmtDate(iso: string): string {
  if (!iso) return '';
  if (iso === todayIso()) return 'today';
  const p = iso.split('-');
  if (p.length !== 3) return iso;
  const day = parseInt(p[2], 10);
  const mon = parseInt(p[1], 10);
  if (!day || !mon) return iso;
  return `${day} ${MONTHS[mon - 1] || ''}`.trim();
}

function daysSince(iso: string): number {
  const today = new Date(todayIso() + 'T00:00:00');
  const then = new Date(iso + 'T00:00:00');
  return Math.round((today.getTime() - then.getTime()) / 86400000);
}

// Recency band for a cell. `never` (no teaching logged) is left visually
// plain — a blank cell among coloured ones IS the gap, no alarm needed.
function recencyClass(iso: string | null): string {
  if (!iso) return 'rc-never';
  const d = daysSince(iso);
  if (d <= 30) return 'rc-recent';
  if (d <= 90) return 'rc-mid';
  return 'rc-old';
}

function personById(id: string): CPerson | undefined { return cPeople.find(p => p.id === id); }
function chunkById(id: string): CChunk | undefined { return cChunks.find(c => c.id === id); }

// Most recent date `chunkId` was taught to `learnerId`, or null.
function lastTaught(learnerId: string, chunkId: string): string | null {
  let best: string | null = null;
  for (const e of cEvents) {
    if (e.learnerId === learnerId && e.chunkId === chunkId) {
      if (!best || e.date > best) best = e.date;
    }
  }
  return best;
}

// ── Render ──

export async function renderCompetencies(): Promise<void> {
  const el = document.getElementById('screen-competencies');
  if (!el) return;
  if (!cLoaded) el.innerHTML = '<div class="comp-loading">Loading…</div>';
  try {
    const data = await apiGet('/api/competencies');
    cChunks = data.chunks || [];
    cPeople = data.people || [];
    cEvents = data.events || [];
    cLoaded = true;
  } catch (e: unknown) {
    el.innerHTML = `<div class="comp-error">Could not load competencies: ${esc(e instanceof Error ? e.message : 'Unknown error')}</div>`;
    return;
  }
  paintComp();
}

function paintComp(): void {
  const el = document.getElementById('screen-competencies');
  if (el) el.innerHTML = buildCompHtml();
}

function buildCompHtml(): string {
  const stations = Array.from(new Set(cChunks.map(c => c.station))).sort();
  const visibleChunks = cStationFilter === 'all'
    ? cChunks
    : cChunks.filter(c => c.station === cStationFilter);

  const filterHtml = stations.length > 1 ? `
    <label class="comp-filter">Station
      <select onchange="setCompStationFilter(this.value)">
        <option value="all"${cStationFilter === 'all' ? ' selected' : ''}>All</option>
        ${stations.map(s => `<option value="${esc(s)}"${cStationFilter === s ? ' selected' : ''}>${esc(s)}</option>`).join('')}
      </select>
    </label>` : '';

  return `
    <div class="comp-header">
      <h2>Competencies</h2>
      <div class="comp-header-actions">
        ${filterHtml}
        <button class="btn" onclick="openCompAddPerson()" data-testid="comp-add-person">+ Add a name</button>
      </div>
    </div>
    <p class="comp-hint">Tap a cell to log a teaching. Green means taught recently; a blank cell means not yet.</p>
    ${buildGridHtml(visibleChunks)}
    ${buildLedgerHtml()}
  `;
}

function buildGridHtml(visibleChunks: CChunk[]): string {
  if (cChunks.length === 0) {
    return '<div class="comp-empty">No chunks in the library yet.</div>';
  }
  if (cPeople.length === 0) {
    return '<div class="comp-empty">No staff added yet. Tap <strong>+ Add a name</strong> to add the first person, then tap a grid cell to log a teaching.</div>';
  }
  const head = visibleChunks.map(c =>
    `<th class="comp-chunkhead" title="${esc(c.station)}">${esc(c.name)}</th>`
  ).join('');
  const rows = cPeople.map(p => {
    const cells = visibleChunks.map(c => {
      const last = lastTaught(p.id, c.id);
      const cls = recencyClass(last);
      const label = last ? esc(fmtDate(last)) : '&mdash;';
      return `<td class="comp-cell ${cls}" data-testid="comp-cell" title="${esc(p.name)} — ${esc(c.name)}" onclick="openCompLogModal('${p.id}','${c.id}')">${label}</td>`;
    }).join('');
    return `<tr><th class="comp-rowhead">${esc(p.name)}</th>${cells}</tr>`;
  }).join('');
  return `
    <div class="comp-grid-wrap">
      <table class="comp-grid">
        <thead><tr><th class="comp-corner"></th>${head}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function buildLedgerHtml(): string {
  const rows = cEvents.slice(0, 20).map(e => {
    const teacher = personById(e.teacherId);
    const learner = personById(e.learnerId);
    const chunk = chunkById(e.chunkId);
    return `<li class="comp-ledger-row" data-testid="comp-ledger-row">
      <span class="comp-ledger-people">${esc(teacher ? teacher.name : '?')} &rarr; ${esc(learner ? learner.name : '?')}</span>
      <span class="comp-ledger-chunk">${esc(chunk ? chunk.name : '?')}</span>
      <span class="comp-ledger-date">${esc(fmtDate(e.date))}</span>
    </li>`;
  }).join('');
  return `
    <div class="comp-ledger">
      <h3>Recently logged</h3>
      ${cEvents.length === 0
        ? '<p class="comp-ledger-empty">No teaching events logged yet.</p>'
        : `<ul class="comp-ledger-list">${rows}</ul>`}
    </div>`;
}

export function setCompStationFilter(value: string): void {
  cStationFilter = value;
  paintComp();
}

// ── Log a teaching (cell tap) ──

export function openCompLogModal(learnerId: string, chunkId: string): void {
  const learner = personById(learnerId);
  const chunk = chunkById(chunkId);
  if (!learner || !chunk) { toast('Could not open the log'); return; }
  logLearnerId = learnerId;
  logChunkId = chunkId;
  logTeacherId = '';
  const last = lastTaught(learnerId, chunkId);
  const teacherBtns = cPeople.map(p =>
    `<button type="button" class="comp-pick-btn" data-teacher="${p.id}" data-testid="comp-teacher-btn" onclick="selectCompTeacher('${p.id}')">${esc(p.name)}</button>`
  ).join('');
  showModal(`
    <div data-testid="comp-log-modal">
      <h3>Log a teaching</h3>
      <p class="comp-log-subject"><strong>${esc(learner.name)}</strong> learned <strong>${esc(chunk.name)}</strong></p>
      ${last ? `<div class="modal-note">Last taught ${esc(fmtDate(last))} — logging again is fine. Repeated teaching counts.</div>` : ''}
      <div class="fr">
        <label>Taught by</label>
        <div class="comp-pick-grid" id="comp-teacher-grid">${teacherBtns}</div>
      </div>
      <div class="fr">
        <label for="comp-log-date">Date</label>
        <input type="date" id="comp-log-date" value="${todayIso()}">
      </div>
      <div class="fr">
        <label for="comp-log-note">Note (optional)</label>
        <input type="text" id="comp-log-note" placeholder="Anything worth remembering" autocomplete="off">
      </div>
      <div class="modal-actions">
        <button class="btn" onclick="closeModal()">Cancel</button>
        <button class="btn btn-purple" id="comp-log-submit" data-testid="comp-log-submit" onclick="submitCompLog()" disabled>Log it</button>
      </div>
    </div>
  `);
}

export function selectCompTeacher(teacherId: string): void {
  logTeacherId = teacherId;
  document.querySelectorAll('#comp-teacher-grid .comp-pick-btn').forEach(b => {
    b.classList.toggle('active', (b as HTMLElement).dataset.teacher === teacherId);
  });
  const submit = document.getElementById('comp-log-submit') as HTMLButtonElement | null;
  if (submit) submit.disabled = false;
}

export async function submitCompLog(): Promise<void> {
  if (!logTeacherId) { toast('Pick who taught it'); return; }
  const dateEl = document.getElementById('comp-log-date') as HTMLInputElement | null;
  const noteEl = document.getElementById('comp-log-note') as HTMLInputElement | null;
  const date = (dateEl && dateEl.value) || todayIso();
  const notes = (noteEl && noteEl.value.trim()) || '';
  try {
    await apiPost('/api/competencies/events', {
      id: newId(),
      chunkId: logChunkId,
      teacherId: logTeacherId,
      learnerId: logLearnerId,
      date,
      notes,
    });
    const learner = personById(logLearnerId);
    const chunk = chunkById(logChunkId);
    closeModal();
    toast(`Logged: ${learner ? learner.name : '?'} — ${chunk ? chunk.name : '?'}`);
    await renderCompetencies();
  } catch (e: unknown) {
    toast('Could not log: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}

// ── Add a name ──

export function openCompAddPerson(): void {
  showModal(`
    <div data-testid="comp-add-modal">
      <h3>Add a name</h3>
      <div class="modal-note">Anyone at Centraal who teaches or learns. You can add more any time.</div>
      <div class="fr">
        <label for="comp-person-name">Name</label>
        <input type="text" id="comp-person-name" placeholder="Name" autocomplete="off">
      </div>
      <div class="modal-actions">
        <button class="btn" onclick="closeModal()">Cancel</button>
        <button class="btn btn-purple" onclick="submitCompAddPerson()">Add</button>
      </div>
    </div>
  `);
  setTimeout(() => {
    const i = document.getElementById('comp-person-name') as HTMLInputElement | null;
    if (i) i.focus();
  }, 50);
}

export async function submitCompAddPerson(): Promise<void> {
  const input = document.getElementById('comp-person-name') as HTMLInputElement | null;
  const name = input ? input.value.trim() : '';
  if (!name) { toast('Enter a name'); return; }
  try {
    await apiPost('/api/competencies/people', { id: newId(), name });
    closeModal();
    toast(`Added ${name}`);
    await renderCompetencies();
  } catch (e: unknown) {
    toast('Could not add: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}

// Self-register so navigate.ts can dispatch without importing this module.
registerRenderer('competencies', renderCompetencies);
