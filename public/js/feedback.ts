import { S } from './state';
import { apiPost, toast, toastError } from './utils';

// Window-indirect aliases (avoid circular deps)
const closeModal = (...args: any[]) => (window as any).closeModal?.(...args);
const esc = (...args: any[]) => (window as any).esc?.(...args);
const showModal = (...args: any[]) => (window as any).showModal?.(...args);

// ── FEEDBACK ──────────────────────────────────────────────

export const feedbackTypes = [
  { key: 'idea',    icon: '&#128161;', label: 'New idea',        prompt: 'What would you like to see? Describe what it would do and why it would help you or the team.' },
  { key: 'issue',   icon: '&#128027;', label: 'Something broke',  prompt: 'What happened? What were you trying to do, and what went wrong? Which screen were you on?' },
  { key: 'confusing', icon: '&#128566;', label: 'Confusing',      prompt: 'What was confusing? What did you expect to happen vs what actually happened?' },
  { key: 'nice',    icon: '&#128077;', label: 'Something nice',   prompt: 'What\'s working well? Knowing what you like helps us keep the good stuff.' },
];

export let feedbackSelectedType = '';

export function openFeedback() {
  const currentScreen = document.querySelector('.screen.active')?.id?.replace('screen-', '') || 'unknown';
  const screenLabels = { dashboard:'Dashboard', guests:'Guests', planner:'Week plan', 'recipe-index':'Recipes', orders:'Orders' };
  const screenLabel = screenLabels[currentScreen] || currentScreen;

  feedbackSelectedType = '';

  showModal(`<h3>Feedback &amp; ideas</h3>
    <p style="font-size:13px;color:var(--text2);margin-bottom:14px;">Help us improve De Sering's food planner. Every bit of feedback counts.</p>
    <div class="feedback-form">
      <div>
        <label style="font-size:12px;font-weight:600;color:var(--text2);display:block;margin-bottom:6px;">What kind of feedback?</label>
        <div class="feedback-type-grid">
          ${feedbackTypes.map(t => `<div class="feedback-type-btn" id="ft-${t.key}" onclick="selectFeedbackType('${t.key}')">
            <span class="ft-icon">${t.icon}</span>
            <span class="ft-label">${t.label}</span>
          </div>`).join('')}
        </div>
      </div>
      <div class="feedback-prompt" id="feedback-prompt"></div>
      <div>
        <textarea class="feedback-textarea" id="feedback-text" placeholder="Tell us what's on your mind..."></textarea>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span class="feedback-screen-tag">Page: ${esc(screenLabel)}</span>
        <span style="font-size:11px;color:var(--text3);" id="feedback-anon">Submitted as ${esc(S.user?.name || 'anonymous')}</span>
      </div>
      <div class="modal-actions" style="margin-top:8px;">
        <button class="btn" onclick="closeModal()">Cancel</button>
        <button class="btn btn-purple" onclick="submitFeedback('${currentScreen}')">Send feedback</button>
      </div>
    </div>`);
}

export function selectFeedbackType(key: any) {
  feedbackSelectedType = key;
  // Update button states
  feedbackTypes.forEach(t => {
    const btn = document.getElementById('ft-' + t.key);
    if (btn) btn.className = 'feedback-type-btn' + (t.key === key ? ' selected' : '');
  });
  // Show prompt hint
  const promptEl = document.getElementById('feedback-prompt');
  const type = feedbackTypes.find(t => t.key === key);
  if (promptEl && type) {
    promptEl.textContent = type.prompt;
    promptEl.className = 'feedback-prompt visible';
  }
  // Focus textarea
  const ta = document.getElementById('feedback-text');
  if (ta) ta.focus();
}

export async function submitFeedback(screen: any) {
  const text = document.getElementById('feedback-text')?.value?.trim();
  if (!text) { alert('Please write something before submitting'); return; }

  const feedback = {
    type: feedbackSelectedType || 'general',
    text,
    screen,
    user: S.user?.name || S.user?.email || 'anonymous',
    timestamp: new Date().toISOString(),
    userAgent: navigator.userAgent,
  };

  try {
    await apiPost('/api/feedback', feedback);
    closeModal();
    toast('Thanks for the feedback!');
  } catch (e: unknown) {
    toastError('Could not send feedback: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}

// Show feedback button when app is visible
export function showFeedbackFab() {
  const fab = document.getElementById('feedback-fab');
  if (fab) fab.style.display = 'flex';
  const tut = document.getElementById('tutorial-fab');
  if (tut) tut.style.display = 'flex';
}
