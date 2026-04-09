import { S } from './state';
import { apiGet, apiPost, toast } from './utils';
import { showModal, closeModal, esc } from './modal';

// ── FEEDBACK ADMIN ──────────────────────────────────────
// View all submitted feedback, filter by type, copy for Claude

export let feedbackData: any[] = [];
export let feedbackFilter = 'all';
export let feedbackShowProcessed = false;

export async function renderFeedbackAdmin() {
  const el = document.getElementById('screen-feedback-admin');
  if (!el) return;

  // Fetch feedback from API
  try {
    feedbackData = await apiGet('/api/feedback');
  } catch (e: unknown) {
    el.innerHTML = `<div class="section-card" style="padding:24px;color:var(--red);">Could not load feedback: ${esc(e instanceof Error ? e.message : 'Unknown error')}</div>`;
    return;
  }

  updateFeedbackUI(el);
}

function updateFeedbackUI(el?: HTMLElement | null) {
  el = el || document.getElementById('screen-feedback-admin');
  if (!el) return;

  // Filter by type
  let filtered = feedbackFilter === 'all'
    ? feedbackData
    : feedbackData.filter((f: any) => f.type === feedbackFilter);

  // Filter by processed state
  const unprocessedCount = feedbackData.filter((f: any) => !f.processed).length;
  const processedCount = feedbackData.filter((f: any) => f.processed).length;
  if (!feedbackShowProcessed) {
    filtered = filtered.filter((f: any) => !f.processed);
  }

  // Count by type (from visible items only — respects processed filter)
  const visibleItems = feedbackShowProcessed ? feedbackData : feedbackData.filter((f: any) => !f.processed);
  const counts: Record<string, number> = { all: visibleItems.length };
  visibleItems.forEach((f: any) => { counts[f.type] = (counts[f.type] || 0) + 1; });

  const typeLabels: Record<string, string> = { idea: 'Ideas', issue: 'Issues', confusing: 'Confusing', nice: 'Nice', general: 'General' };
  const typeIcons: Record<string, string> = { idea: '&#128161;', issue: '&#128027;', confusing: '&#128566;', nice: '&#128077;', general: '&#128172;' };

  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:16px;">
      <h2 style="margin:0;">Feedback (${unprocessedCount} open${processedCount ? `, ${processedCount} done` : ''})</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn${feedbackShowProcessed ? ' btn-purple' : ''}" style="font-size:12px;" onclick="toggleFeedbackProcessed()">
          ${feedbackShowProcessed ? '&#9745; Show processed' : '&#9744; Show processed'}
        </button>
        <button class="btn btn-purple" onclick="copyFeedbackForClaude()" title="Copy all feedback as text for pasting into Claude">
          &#128203; Copy for Claude
        </button>
      </div>
    </div>

    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px;">
      ${['all', 'idea', 'issue', 'confusing', 'nice', 'general'].map(t =>
        `<button class="btn${feedbackFilter === t ? ' btn-purple' : ''}" style="font-size:12px;padding:5px 12px;" onclick="setFeedbackFilter('${t}')">
          ${t === 'all' ? 'All' : (typeIcons[t] || '') + ' ' + (typeLabels[t] || t)} (${counts[t] || 0})
        </button>`
      ).join('')}
    </div>

    ${filtered.length === 0
      ? '<div class="section-card" style="padding:24px;text-align:center;color:var(--text2);">No feedback to show</div>'
      : filtered.map((f: any) => {
          const date = formatFeedbackDate(f.timestamp);
          const icon = typeIcons[f.type] || '';
          const label = typeLabels[f.type] || f.type;
          const screenLabels: Record<string, string> = { dashboard:'Dashboard', guests:'Guests', planner:'Week plan', 'recipe-index':'Recipes', orders:'Orders', 'feedback-admin':'Feedback' };
          const screenLabel = screenLabels[f.screen] || f.screen || '—';
          const processedClass = f.processed ? ' feedback-processed' : '';

          return `<div class="section-card feedback-card${processedClass}" style="position:relative;${f.processed ? 'opacity:0.6;' : ''}">
            <div class="feedback-card-header">
              <span class="feedback-card-type">${icon} ${esc(label)}</span>
              <span class="feedback-card-screen">${esc(screenLabel)}</span>
              <span class="feedback-card-meta">${esc(f.user)} &middot; ${esc(date)}</span>
              <button class="btn btn-sm" style="margin-left:auto;font-size:11px;padding:3px 10px;" onclick="toggleFeedbackItemProcessed(${f.id}, ${!f.processed})">
                ${f.processed ? '&#8634; Reopen' : '&#10003; Done'}
              </button>
            </div>
            <div class="feedback-card-text">${esc(f.text)}</div>
          </div>`;
        }).join('')
    }
  `;
}

export async function toggleFeedbackItemProcessed(id: number, processed: boolean) {
  try {
    await apiPost(`/api/feedback/${id}`, { processed }, 'PATCH');
    // Update local data
    const item = feedbackData.find((f: any) => f.id === id);
    if (item) item.processed = processed;
    updateFeedbackUI();
    toast(processed ? 'Marked as done' : 'Reopened');
  } catch (e: unknown) {
    toast('Error: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}

export function toggleFeedbackProcessed() {
  feedbackShowProcessed = !feedbackShowProcessed;
  updateFeedbackUI();
}

export function setFeedbackFilter(type: any) {
  feedbackFilter = type;
  updateFeedbackUI();
}

export function formatFeedbackDate(ts: any) {
  if (!ts) return '—';
  try {
    const d = new Date(ts);
    const day = d.getDate().toString().padStart(2, '0');
    const mon = (d.getMonth() + 1).toString().padStart(2, '0');
    const hr = d.getHours().toString().padStart(2, '0');
    const min = d.getMinutes().toString().padStart(2, '0');
    return `${day}-${mon} ${hr}:${min}`;
  } catch { return ts; }
}

export function copyFeedbackForClaude() {
  const items = feedbackFilter === 'all'
    ? feedbackData
    : feedbackData.filter((f: any) => f.type === feedbackFilter);

  // Only copy unprocessed items unless showing processed
  const toCopy = feedbackShowProcessed ? items : items.filter((f: any) => !f.processed);

  if (toCopy.length === 0) {
    toast('No feedback to copy');
    return;
  }

  const lines = toCopy.map((f: any) => {
    const date = formatFeedbackDate(f.timestamp);
    const screenLabels: Record<string, string> = { dashboard:'Dashboard', guests:'Guests', planner:'Week plan', 'recipe-index':'Recipes', orders:'Orders' };
    const screen = screenLabels[f.screen] || f.screen || '—';
    const status = f.processed ? ' [DONE]' : '';
    return `[${f.type}]${status} (${screen}, ${f.user}, ${date})\n${f.text}`;
  });

  const text = `=== Sering Food Planner Feedback (${toCopy.length} items) ===\n\n${lines.join('\n\n---\n\n')}`;

  navigator.clipboard.writeText(text).then(() => {
    toast('Copied ' + toCopy.length + ' feedback items — paste into Claude chat');
  }).catch(() => {
    // Fallback: show in modal for manual copy
    showModal(`<h3>Feedback export</h3>
      <p style="font-size:12px;color:var(--text2);margin-bottom:8px;">Copy the text below and paste it into Claude:</p>
      <textarea style="width:100%;height:300px;font-size:12px;font-family:monospace;" readonly>${esc(text)}</textarea>
      <div class="modal-actions" style="margin-top:8px;">
        <button class="btn" onclick="closeModal()">Close</button>
      </div>`);
  });
}
