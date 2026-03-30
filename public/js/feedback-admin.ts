import { S } from './state';
import { apiGet, toast } from './utils';

// Window-indirect aliases (avoid circular deps)
const closeModal = (...args: any[]) => (window as any).closeModal?.(...args);
const esc = (...args: any[]) => (window as any).esc?.(...args);
const showModal = (...args: any[]) => (window as any).showModal?.(...args);

// ── FEEDBACK ADMIN ──────────────────────────────────────
// View all submitted feedback, filter by type, copy for Claude

export let feedbackData = [];
export let feedbackFilter = 'all';

export async function renderFeedbackAdmin() {
  const el = document.getElementById('screen-feedback-admin');
  if (!el) return;

  // Fetch feedback from API
  try {
    feedbackData = await apiGet('/api/feedback');
  } catch (e: any) {
    el.innerHTML = `<div class="section-card" style="padding:24px;color:var(--red);">Could not load feedback: ${esc(e.message)}</div>`;
    return;
  }

  const filtered = feedbackFilter === 'all'
    ? feedbackData
    : feedbackData.filter(f => f.type === feedbackFilter);

  // Count by type
  const counts = { all: feedbackData.length };
  feedbackData.forEach(f => { counts[f.type] = (counts[f.type] || 0) + 1; });

  const typeLabels = { idea: 'Ideas', issue: 'Issues', confusing: 'Confusing', nice: 'Nice', general: 'General' };
  const typeIcons = { idea: '&#128161;', issue: '&#128027;', confusing: '&#128566;', nice: '&#128077;', general: '&#128172;' };

  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:16px;">
      <h2 style="margin:0;">Feedback (${feedbackData.length})</h2>
      <button class="btn btn-purple" onclick="copyFeedbackForClaude()" title="Copy all feedback as text for pasting into Claude">
        &#128203; Copy for Claude
      </button>
    </div>

    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px;">
      ${['all', 'idea', 'issue', 'confusing', 'nice', 'general'].map(t =>
        `<button class="btn${feedbackFilter === t ? ' btn-purple' : ''}" style="font-size:12px;padding:5px 12px;" onclick="setFeedbackFilter('${t}')">
          ${t === 'all' ? 'All' : (typeIcons[t] || '') + ' ' + (typeLabels[t] || t)} (${counts[t] || 0})
        </button>`
      ).join('')}
    </div>

    ${filtered.length === 0
      ? '<div class="section-card" style="padding:24px;text-align:center;color:var(--text2);">No feedback yet</div>'
      : filtered.map(f => {
          const date = formatFeedbackDate(f.timestamp);
          const icon = typeIcons[f.type] || '';
          const label = typeLabels[f.type] || f.type;
          const screenLabels = { dashboard:'Dashboard', guests:'Guests', planner:'Week plan', 'recipe-index':'Recipes', orders:'Orders' };
          const screenLabel = screenLabels[f.screen] || f.screen || '—';

          return `<div class="section-card feedback-card">
            <div class="feedback-card-header">
              <span class="feedback-card-type">${icon} ${esc(label)}</span>
              <span class="feedback-card-screen">${esc(screenLabel)}</span>
              <span class="feedback-card-meta">${esc(f.user)} &middot; ${esc(date)}</span>
            </div>
            <div class="feedback-card-text">${esc(f.text)}</div>
          </div>`;
        }).join('')
    }
  `;
}

export function setFeedbackFilter(type: any) {
  feedbackFilter = type;
  renderFeedbackAdmin();
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
    : feedbackData.filter(f => f.type === feedbackFilter);

  if (items.length === 0) {
    toast('No feedback to copy');
    return;
  }

  const lines = items.map(f => {
    const date = formatFeedbackDate(f.timestamp);
    const screenLabels = { dashboard:'Dashboard', guests:'Guests', planner:'Week plan', 'recipe-index':'Recipes', orders:'Orders' };
    const screen = screenLabels[f.screen] || f.screen || '—';
    return `[${f.type}] (${screen}, ${f.user}, ${date})\n${f.text}`;
  });

  const text = `=== Sering Food Planner Feedback (${items.length} items) ===\n\n${lines.join('\n\n---\n\n')}`;

  navigator.clipboard.writeText(text).then(() => {
    toast('Copied ' + items.length + ' feedback items — paste into Claude chat');
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
