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
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { splitGuideSections } from './chunk-guide';

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

// Which view is showing: the grid (home), a detail drill-down, or admin.
let cView: 'grid' | 'person' | 'chunk' | 'admin' = 'grid';
let cPersonId = '';
let cChunkId = '';
let cIsStaffLead = false;
let cLastSync: {
  synced: string[];
  warned: { name: string; warnings: string[] }[];
  flagged: { name: string; reason: string }[];
} | null = null;
let renamePersonId = '';
let pendingDeleteEventId = '';

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
// People still on the roster — the grid, pickers and chunk roster use these;
// the admin view manages the full list (active + deactivated).
function activePeople(): CPerson[] { return cPeople.filter(p => p.active); }

// Most recent date `chunkId` was taught to `learnerId`, or null. `date` is
// zero-padded ISO (YYYY-MM-DD) — the only write path is an <input type="date">
// — so the string comparison below sorts chronologically.
function lastTaught(learnerId: string, chunkId: string): string | null {
  let best: string | null = null;
  for (const e of cEvents) {
    if (e.learnerId === learnerId && e.chunkId === chunkId) {
      if (!best || e.date > best) best = e.date;
    }
  }
  return best;
}

// A chunk's deeperLink comes from a Notion URL property — only render it as a
// link if it is a real http(s) URL, so a javascript: scheme can't be clicked.
function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

// ── Render ──

export async function renderCompetencies(): Promise<void> {
  const el = document.getElementById('screen-competencies');
  if (!el) return;
  // Paint from the module cache once loaded (audit ARCH-1): the 60s background
  // tick and SSE-triggered re-renders must NOT refetch the whole (ever-growing)
  // teaching-event ledger every minute. Explicit reloads — first screen load and
  // after a local mutation — go through reloadCompetencies(), which clears cLoaded.
  if (cLoaded) { paintComp(); return; }
  el.innerHTML = '<div class="comp-loading">Loading…</div>';
  try {
    const data = await apiGet('/api/competencies');
    cChunks = data.chunks || [];
    cPeople = data.people || [];
    cEvents = data.events || [];
    cIsStaffLead = !!data.isStaffLead;
    cLoaded = true;
  } catch (e: unknown) {
    el.innerHTML = `<div class="comp-error">Could not load the training grid: ${esc(e instanceof Error ? e.message : 'Unknown error')}</div>`;
    return;
  }
  paintComp();
}

/** Force a fresh fetch of the training data, then repaint. Called after a local
 *  mutation (log event, add/rename/(de)activate person, sync, delete) so the
 *  change shows; the plain renderer paints from cache. */
export async function reloadCompetencies(): Promise<void> {
  cLoaded = false;
  return renderCompetencies();
}

function paintComp(): void {
  const el = document.getElementById('screen-competencies');
  if (!el) return;
  el.innerHTML =
    cView === 'person' ? buildPersonHtml(cPersonId)
      : cView === 'chunk' ? buildChunkHtml(cChunkId)
        : cView === 'admin' ? buildAdminHtml()
          : buildCompHtml();
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
      <h2>Training</h2>
      <div class="comp-header-actions">
        ${filterHtml}
        <button class="btn" onclick="openCompAddPerson()" data-testid="comp-add-person">+ Add a name</button>
        ${cIsStaffLead ? '<button class="btn" onclick="openCompAdmin()" data-testid="comp-admin-btn">Admin</button>' : ''}
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
  const people = activePeople();
  if (people.length === 0) {
    return '<div class="comp-empty">No staff added yet. Tap <strong>+ Add a name</strong> to add the first person, then tap a grid cell to log a teaching.</div>';
  }
  const head = visibleChunks.map(c =>
    `<th class="comp-chunkhead" data-testid="comp-chunkhead" data-chunk="${esc(c.id)}" title="${esc(c.name)} — ${esc(c.station)}" onclick="openCompChunk(this.dataset.chunk)">${esc(c.name)}</th>`
  ).join('');
  const rows = people.map(p => {
    const cells = visibleChunks.map(c => {
      const last = lastTaught(p.id, c.id);
      const cls = recencyClass(last);
      const label = last ? esc(fmtDate(last)) : '&mdash;';
      return `<td class="comp-cell ${cls}" data-testid="comp-cell" data-learner="${esc(p.id)}" data-chunk="${esc(c.id)}" title="${esc(p.name)} — ${esc(c.name)}" onclick="openCompLogModal(this.dataset.learner, this.dataset.chunk)">${label}</td>`;
    }).join('');
    return `<tr><th class="comp-rowhead" data-person="${esc(p.id)}" title="See ${esc(p.name)}'s history" onclick="openCompPerson(this.dataset.person)">${esc(p.name)}</th>${cells}</tr>`;
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

// ── Per-person detail (row-header tap) ──

export function openCompPerson(personId: string): void {
  cView = 'person';
  cPersonId = personId;
  paintComp();
}

export function compBackToGrid(): void {
  cView = 'grid';
  cPersonId = '';
  cChunkId = '';
  paintComp();
}

// "What chunks has this person had?" — their teaching history grouped by
// station, plus the chunks they have not had yet (the per-person gap,
// computed against the chunk library by station).
function buildPersonHtml(personId: string): string {
  const person = personById(personId);
  if (!person) {
    return `
      <div class="comp-detail-head">
        <button class="btn" onclick="compBackToGrid()">&larr; Grid</button>
      </div>
      <div class="comp-empty">That person is no longer in the list.</div>`;
  }
  // Their teaching events, newest first (date is zero-padded ISO).
  const myEvents = cEvents
    .filter(e => e.learnerId === personId)
    .slice()
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const hadChunkIds = new Set(myEvents.map(e => e.chunkId));
  const stations = Array.from(new Set(cChunks.map(c => c.station)));

  const taught = stations.map(station => {
    const evs = myEvents.filter(e => {
      const ch = chunkById(e.chunkId);
      return !!ch && ch.station === station;
    });
    if (evs.length === 0) return '';
    const rows = evs.map(e => {
      const ch = chunkById(e.chunkId);
      const teacher = personById(e.teacherId);
      return `<li class="comp-person-event">
        <span class="comp-person-chunk">${esc(ch ? ch.name : '?')}</span>
        <span class="comp-person-by">taught by ${esc(teacher ? teacher.name : '?')}</span>
        <span class="comp-person-date">${esc(fmtDate(e.date))}</span>
      </li>`;
    }).join('');
    return `<div class="comp-person-station"><h4>${esc(station)}</h4><ul class="comp-person-list">${rows}</ul></div>`;
  }).join('');

  const gaps = stations.map(station => {
    const missing = cChunks.filter(c => c.station === station && !hadChunkIds.has(c.id));
    if (missing.length === 0) return '';
    const items = missing.map(c => `<li class="comp-person-gap">${esc(c.name)}</li>`).join('');
    return `<div class="comp-person-station"><h4>${esc(station)}</h4><ul class="comp-person-list">${items}</ul></div>`;
  }).join('');

  return `
    <div class="comp-detail-head">
      <button class="btn" onclick="compBackToGrid()">&larr; Grid</button>
      <h2>${esc(person.name)}</h2>
    </div>
    <div class="comp-person-block">
      <h3>Taught</h3>
      ${taught || '<p class="comp-person-empty">No teaching logged yet.</p>'}
    </div>
    <div class="comp-person-block">
      <h3>Not yet</h3>
      ${gaps || '<p class="comp-person-empty">Has been taught every chunk in the library.</p>'}
    </div>
  `;
}

// ── Per-chunk detail (column-header tap) ──

export function openCompChunk(chunkId: string): void {
  cView = 'chunk';
  cChunkId = chunkId;
  paintComp();
}

// marked runs synchronously with default options; the union return type is
// over-broad. Chunk guides sync in from Notion (externally-editable content),
// so the rendered HTML is sanitised with DOMPurify before it reaches
// innerHTML — marked itself passes raw HTML straight through.
function mdToHtml(md: string): string {
  return DOMPurify.sanitize(marked.parse(md) as string);
}

// The teaching guide: an always-open intro, then each `## ` section as a
// collapsed <details>. Collapsed, the section headlines are the 30-minute
// teaching checklist; tap one to open its prose.
function renderTeachingGuide(md: string): string {
  const { intro, sections } = splitGuideSections(md);
  const introHtml = intro ? `<div class="comp-guide-intro">${mdToHtml(intro)}</div>` : '';
  const sectionsHtml = sections.map(s =>
    `<details class="comp-guide-section" data-testid="comp-guide-section">`
    + `<summary>${esc(s.heading)}</summary>`
    + `<div class="comp-guide-body">${mdToHtml(s.body)}</div>`
    + `</details>`
  ).join('');
  return `<div class="comp-guide">${introHtml}${sectionsHtml}</div>`;
}

// "Who has had this chunk?" — the teaching guide, plus who's had it / who hasn't.
function buildChunkHtml(chunkId: string): string {
  const chunk = chunkById(chunkId);
  if (!chunk) {
    return `
      <div class="comp-detail-head">
        <button class="btn" onclick="compBackToGrid()">&larr; Grid</button>
      </div>
      <div class="comp-empty">That chunk is no longer in the library.</div>`;
  }
  const roster = activePeople().map(p => ({ person: p, last: lastTaught(p.id, chunkId) }));
  const had = roster.filter(r => r.last)
    .sort((a, b) => ((a.last as string) < (b.last as string) ? 1 : -1));
  const notHad = roster.filter(r => !r.last);

  const prereqHtml = chunk.prerequisites.length
    ? `<div class="comp-chunk-meta"><span class="comp-chunk-meta-label">Prerequisites</span>${chunk.prerequisites.map(id => { const pc = chunkById(id); return `<span class="comp-tag">${esc(pc ? pc.name : id)}</span>`; }).join('')}</div>`
    : '';
  const requiredHtml = chunk.requiredFor.length
    ? `<div class="comp-chunk-meta"><span class="comp-chunk-meta-label">Required for</span>${chunk.requiredFor.map(r => `<span class="comp-tag">${esc(r)}</span>`).join('')}</div>`
    : '';
  const safeLink = safeHttpUrl(chunk.deeperLink);
  const linkHtml = safeLink
    ? `<p class="comp-chunk-link"><a href="${esc(safeLink)}" target="_blank" rel="noopener noreferrer">Deeper documentation &rarr;</a></p>`
    : '';

  return `
    <div class="comp-detail-head">
      <button class="btn" onclick="compBackToGrid()">&larr; Grid</button>
      <h2>${esc(chunk.name)}</h2>
    </div>
    <div data-testid="comp-chunk-detail">
      <div class="comp-chunk-sub">${esc(chunk.station)} &middot; ${esc(chunk.type)}</div>
      ${chunk.goal ? `<p class="comp-chunk-goal">${esc(chunk.goal)}</p>` : ''}
      ${prereqHtml}${requiredHtml}${linkHtml}
      <div class="comp-person-block">
        <h3>Teaching guide</h3>
        ${chunk.teachingGuide ? renderTeachingGuide(chunk.teachingGuide) : '<p class="comp-person-empty">No teaching guide written yet.</p>'}
      </div>
      <div class="comp-person-block">
        <h3>Who's had it</h3>
        ${had.length
          ? `<ul class="comp-person-list">${had.map(r => `<li class="comp-who"><span class="comp-who-name">${esc(r.person.name)}</span><span class="comp-who-date">${esc(fmtDate(r.last as string))}</span></li>`).join('')}</ul>`
          : '<p class="comp-person-empty">No one has been taught this yet.</p>'}
      </div>
      <div class="comp-person-block">
        <h3>Not yet</h3>
        ${notHad.length
          ? `<ul class="comp-person-list">${notHad.map(r => `<li class="comp-person-gap">${esc(r.person.name)}</li>`).join('')}</ul>`
          : '<p class="comp-person-empty">Everyone has had this chunk.</p>'}
      </div>
    </div>
  `;
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
  const teacherBtns = activePeople().map(p =>
    `<button type="button" class="comp-pick-btn" data-teacher="${esc(p.id)}" data-testid="comp-teacher-btn" onclick="selectCompTeacher(this.dataset.teacher)">${esc(p.name)}</button>`
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
        <input type="date" id="comp-log-date" value="${todayIso()}" max="${todayIso()}">
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
    await reloadCompetencies();
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
    await reloadCompetencies();
  } catch (e: unknown) {
    toast('Could not add: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}

// ── Admin (staff-leads only) ──

export function openCompAdmin(): void {
  cView = 'admin';
  paintComp();
}

// The report from the last "Sync from Notion" run, shown under the button.
function syncResultHtml(): string {
  if (!cLastSync) return '';
  const { synced, warned, flagged } = cLastSync;
  const total = synced.length + warned.length;
  const warnedHtml = warned.length
    ? `<div class="comp-sync-warned"><strong>Imported, but some content was skipped (${warned.length}):</strong>`
      + `<ul>${warned.map(w => `<li>${esc(w.name)} — ${esc(w.warnings.join('; '))}</li>`).join('')}</ul></div>`
    : '';
  const flaggedHtml = flagged.length
    ? `<div class="comp-sync-flagged"><strong>Held back (${flagged.length}) — fix in Notion and sync again:</strong>`
      + `<ul>${flagged.map(f => `<li>${esc(f.name)} — ${esc(f.reason)}</li>`).join('')}</ul></div>`
    : '';
  return `<div class="comp-sync-result">
    <p>Synced ${total} chunk${total === 1 ? '' : 's'} from Notion.</p>
    ${warnedHtml}${flaggedHtml}
  </div>`;
}

// The admin view: sync the chunk library from Notion, manage the people
// roster, and correct teaching events. Staff-lead only — the Admin button
// that reaches here is hidden for everyone else (and the endpoints 403).
function buildAdminHtml(): string {
  const people = cPeople.slice().sort((a, b) => a.name.localeCompare(b.name));
  const peopleRows = people.map(p =>
    `<li class="comp-admin-person${p.active ? '' : ' comp-admin-inactive'}">
      <span class="comp-admin-name">${esc(p.name)}${p.active ? '' : ' (deactivated)'}</span>
      <span class="comp-admin-actions">
        <button class="btn" data-person="${esc(p.id)}" onclick="compRenamePerson(this.dataset.person)">Rename</button>
        <button class="btn" data-person="${esc(p.id)}" onclick="compTogglePersonActive(this.dataset.person)">${p.active ? 'Deactivate' : 'Reactivate'}</button>
      </span>
    </li>`
  ).join('');

  const eventRows = cEvents.slice(0, 50).map(e => {
    const teacher = personById(e.teacherId);
    const learner = personById(e.learnerId);
    const chunk = chunkById(e.chunkId);
    return `<li class="comp-admin-event">
      <span class="comp-admin-event-text">${esc(teacher ? teacher.name : '?')} &rarr; ${esc(learner ? learner.name : '?')} &middot; ${esc(chunk ? chunk.name : '?')} &middot; ${esc(fmtDate(e.date))}</span>
      <button class="btn btn-danger" data-event="${esc(e.id)}" onclick="compDeleteEvent(this.dataset.event)">Delete</button>
    </li>`;
  }).join('');

  return `
    <div class="comp-detail-head">
      <button class="btn" onclick="compBackToGrid()">&larr; Grid</button>
      <h2>Admin</h2>
    </div>
    <div class="comp-person-block">
      <h3>Chunk library</h3>
      <p class="comp-hint">Chunks are written and edited in Notion. Sync pulls the latest version in — it never deletes.</p>
      <button class="btn btn-purple" onclick="compSyncNotion()" data-testid="comp-sync-btn">Sync from Notion</button>
      ${syncResultHtml()}
    </div>
    <div class="comp-person-block">
      <h3>People</h3>
      ${people.length
        ? `<ul class="comp-admin-list">${peopleRows}</ul>`
        : '<p class="comp-person-empty">No people yet.</p>'}
    </div>
    <div class="comp-person-block">
      <h3>Recent teaching events</h3>
      <p class="comp-hint">Delete an event logged by mistake.</p>
      ${cEvents.length
        ? `<ul class="comp-admin-list">${eventRows}</ul>`
        : '<p class="comp-person-empty">No teaching events logged yet.</p>'}
    </div>
  `;
}

export async function compSyncNotion(): Promise<void> {
  toast('Syncing from Notion…');
  try {
    const report = await apiPost('/api/competencies/sync-chunks', {});
    cLastSync = {
      synced: report.synced || [],
      warned: report.warned || [],
      flagged: report.flagged || [],
    };
    const total = cLastSync.synced.length + cLastSync.warned.length;
    toast(`Synced ${total} chunk${total === 1 ? '' : 's'}`);
    await reloadCompetencies();
  } catch (e: unknown) {
    toast('Sync failed: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}

export function compRenamePerson(personId: string): void {
  const person = personById(personId);
  if (!person) { toast('That person is no longer in the list'); return; }
  renamePersonId = personId;
  showModal(`
    <div data-testid="comp-rename-modal">
      <h3>Rename</h3>
      <div class="fr">
        <label for="comp-rename-input">Name</label>
        <input type="text" id="comp-rename-input" value="${esc(person.name)}" autocomplete="off">
      </div>
      <div class="modal-actions">
        <button class="btn" onclick="closeModal()">Cancel</button>
        <button class="btn btn-purple" onclick="submitCompRename()">Save</button>
      </div>
    </div>
  `);
  setTimeout(() => {
    const i = document.getElementById('comp-rename-input') as HTMLInputElement | null;
    if (i) { i.focus(); i.select(); }
  }, 50);
}

export async function submitCompRename(): Promise<void> {
  const input = document.getElementById('comp-rename-input') as HTMLInputElement | null;
  const name = input ? input.value.trim() : '';
  if (!name) { toast('Enter a name'); return; }
  try {
    await apiPost('/api/competencies/people/' + renamePersonId, { name }, 'PATCH');
    closeModal();
    toast('Renamed');
    await reloadCompetencies();
  } catch (e: unknown) {
    toast('Could not rename: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}

export async function compTogglePersonActive(personId: string): Promise<void> {
  const person = personById(personId);
  if (!person) { toast('That person is no longer in the list'); return; }
  try {
    await apiPost('/api/competencies/people/' + personId, { active: !person.active }, 'PATCH');
    toast(person.active ? `${person.name} deactivated` : `${person.name} reactivated`);
    await reloadCompetencies();
  } catch (e: unknown) {
    toast('Could not update: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}

export function compDeleteEvent(eventId: string): void {
  const ev = cEvents.find(e => e.id === eventId);
  if (!ev) { toast('That event is no longer in the ledger'); return; }
  pendingDeleteEventId = eventId;
  const teacher = personById(ev.teacherId);
  const learner = personById(ev.learnerId);
  const chunk = chunkById(ev.chunkId);
  showModal(`
    <div data-testid="comp-delete-event-modal">
      <h3>Delete this teaching event?</h3>
      <p class="comp-log-subject">${esc(teacher ? teacher.name : '?')} &rarr; ${esc(learner ? learner.name : '?')} &middot; <strong>${esc(chunk ? chunk.name : '?')}</strong> &middot; ${esc(fmtDate(ev.date))}</p>
      <div class="modal-note">This removes the event from the ledger and the grid. It cannot be undone.</div>
      <div class="modal-actions">
        <button class="btn" onclick="closeModal()">Cancel</button>
        <button class="btn btn-danger" onclick="confirmCompDeleteEvent()">Delete</button>
      </div>
    </div>
  `);
}

export async function confirmCompDeleteEvent(): Promise<void> {
  if (!pendingDeleteEventId) { closeModal(); return; }
  try {
    await apiPost('/api/competencies/events/' + pendingDeleteEventId, {}, 'DELETE');
    pendingDeleteEventId = '';
    closeModal();
    toast('Event deleted');
    await reloadCompetencies();
  } catch (e: unknown) {
    toast('Could not delete: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}

// Self-register so navigate.ts can dispatch without importing this module.
registerRenderer('competencies', renderCompetencies);
