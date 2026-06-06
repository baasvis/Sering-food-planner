// ─────────────────────────────────────────────────────────────────────────────
// DRINKS — Bar / service-cards tab (M7). Bartender mode: published, sellable
// drinks for this location as a fast, searchable grid; tap a card for a
// full-screen build card (glass, serve ml, build steps, garnish, premix dose).
// Read-only, large type, dark-mode friendly. Per DRINKS_DOMAIN.md §5.
//
// "Active assortment" here = published+sellable at the current location; M8 adds
// curated per-assortment selection (see DECISIONS.md [m7]).
// ─────────────────────────────────────────────────────────────────────────────

import { S } from './state';
import { showModal, esc } from './modal';
import { drinkCategoryLabel } from './drinks-constants';
import { apiPost, toast, toastError, loadDrinks } from './utils';
import type { Drink } from '@shared/types';

let _barSearch = '';
let _barCat = 'all';

function loc(): string { return S.currentLoc || 'west'; }

/** Published, sellable drinks available at the current location. */
function barDrinks(): Drink[] {
  return (S.drinks || []).filter(d =>
    d.status === 'published' && d.sellable && !d.archived
    && (d.locations?.[loc()]?.active !== false));
}

function servePrice(d: Drink): number | null {
  const f = (d.formats || []).find(x => x.price?.[loc()] != null) || (d.formats || [])[0];
  return f && f.price && f.price[loc()] != null ? (f.price[loc()] as number) : null;
}

export function renderDrinksBarTab(): void {
  const body = document.getElementById('drinks-tab-body');
  if (!body) return;
  const cats = [...new Set(barDrinks().map(d => d.category))];
  body.innerHTML = `
    <div class="drinks-toolbar">
      <input class="drinks-search" id="drinks-bar-search" data-testid="bar-search" placeholder="Search the bar…" value="${esc(_barSearch)}" oninput="drinksBarSearch(this.value)">
    </div>
    <div class="drinks-filter-bar">
      <button class="fc ${_barCat === 'all' ? 'on' : ''}" onclick="drinksBarCategory('all')">All</button>
      ${cats.map(c => `<button class="fc ${_barCat === c ? 'on' : ''}" onclick="drinksBarCategory('${esc(c)}')">${esc(drinkCategoryLabel(c))}</button>`).join('')}
    </div>
    <div id="drinks-bar-results"></div>`;
  updateBarResults();
}

export function drinksBarSearch(v: string): void { _barSearch = v; updateBarResults(); }
export function drinksBarCategory(c: string): void {
  _barCat = c;
  document.querySelectorAll('#drinks-tab-body .drinks-filter-bar .fc').forEach(b =>
    b.classList.toggle('on', ((b as HTMLElement).getAttribute('onclick') || '').includes(`'${c}'`)));
  updateBarResults();
}

/** Group order so the floor sheet reads top-down the way staff work a service. */
const BAR_GROUP_ORDER = ['cocktail', 'homemade-na', 'beer', 'wine', 'spirits', 'soft', 'coffee-drink'];

function updateBarResults(): void {
  const wrap = document.getElementById('drinks-bar-results');
  if (!wrap) return;
  let list = barDrinks();
  if (_barCat !== 'all') list = list.filter(d => d.category === _barCat);
  const q = _barSearch.trim().toLowerCase();
  if (q) list = list.filter(d => d.name.toLowerCase().includes(q) || (d.subtype || '').toLowerCase().includes(q) || (d.characteristics || []).some(c => c.toLowerCase().includes(q)));
  if (list.length === 0) { wrap.innerHTML = `<div class="drinks-empty">No drinks${q ? ' match' : ' published for this bar'}.</div>`; return; }

  // Group by category so each type's relevant info shows together, in service order.
  const groups = new Map<string, Drink[]>();
  for (const d of list) { const g = groups.get(d.category) || []; g.push(d); groups.set(d.category, g); }
  const cats = [...groups.keys()].sort((a, b) => {
    const ia = BAR_GROUP_ORDER.indexOf(a), ib = BAR_GROUP_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  wrap.innerHTML = cats.map(cat => {
    const items = (groups.get(cat) || []).sort((a, b) => a.name.localeCompare(b.name));
    return `<section class="bar-group">
      <h3 class="bar-group-title">${esc(drinkCategoryLabel(cat))} <span class="bar-group-count">${items.length}</span></h3>
      <div class="bar-cards">${items.map(barCardHtml).join('')}</div>
    </section>`;
  }).join('');
}

/** A bar card shows the info a bartender actually needs for THIS type, inline —
 *  wine: origin + grapes + tasting notes; soft: pairing; cocktail/coffee: how to
 *  serve / make (with a tap-to-enlarge build card); beer/spirits: ABV + serve. */
function barCardHtml(d: Drink): string {
  const price = servePrice(d);
  const cat = d.category;
  const info = d.info || {};
  const rows: string[] = [];
  const row = (k: string, v: string | null | undefined) => {
    if (v) rows.push(`<div class="bar-info-row"><span class="bar-info-k">${esc(k)}</span><span class="bar-info-v">${esc(v)}</span></div>`);
  };
  const isCocktail = cat === 'cocktail' || cat === 'homemade-na';

  if (cat === 'wine') {
    row('Origin', [info.region, info.country].filter(Boolean).join(', '));
    row('Grape', info.grapes);
    row('Vintage', info.vintage);
    const style = [info.natural ? 'natural' : '', info.bio ? 'bio' : ''].filter(Boolean).join(' · ');
    row('Style', style);
    row('Tasting', info.notes || info.profile);
    row('Serve', d.servingTemp);
  } else if (cat === 'soft') {
    row('Serve', d.servingTemp);
    row('Serve with', d.serviceInstructions);
  } else if (isCocktail) {
    row('Serve', [d.glass, d.serveVolumeMl ? d.serveVolumeMl + ' ml' : '', (d.garnish || []).join(', ')].filter(Boolean).join(' · '));
    row('How to serve', d.serviceInstructions || (d.prepSteps || []).join(' · '));
  } else if (cat === 'coffee-drink') {
    row('How to make', (d.prepSteps || []).join(' · ') || d.serviceInstructions);
    row('Serve', [d.glass, d.servingTemp].filter(Boolean).join(' · '));
  } else {
    // beer / spirits / anything else
    row('ABV', d.abv ? d.abv + '%' : '');
    row('Serve', d.servingTemp);
    row('Notes', d.serviceInstructions);
  }

  return `<div class="bar-card" data-testid="bar-card" data-id="${esc(d.id)}">
    ${d.photoUrl ? `<img class="bar-card-photo" src="${esc(d.photoUrl)}" alt="${esc(d.name)}" loading="lazy">` : ''}
    <div class="bar-card-head">
      <div class="bar-card-name">${esc(d.name)}${d.subtype ? `<span class="bar-card-sub">${esc(d.subtype)}</span>` : ''}</div>
      ${price != null ? `<div class="bar-card-price">€${price.toFixed(2)}</div>` : ''}
    </div>
    ${rows.length ? `<div class="bar-card-body">${rows.join('')}</div>` : '<div class="bar-card-body bar-card-empty">No details yet — add them on the Catalogue/Recipes tab.</div>'}
    <div class="bar-card-foot">
      <span class="bar-card-photo-actions">
        <button class="btn btn-sm" type="button" data-testid="bar-photo-btn" onclick="drinkBarAddPhoto('${esc(d.id)}')">📷 ${d.photoUrl ? 'Change' : 'Add photo'}</button>
        ${d.photoUrl ? `<button class="btn btn-sm btn-danger" type="button" onclick="drinkBarRemovePhoto('${esc(d.id)}')">✕</button>` : ''}
      </span>
    </div>
  </div>`;
}

/** Pick + upload a final-product photo for a drink (multipart). Open to any
 *  signed-in user. Reloads + re-renders so the new photo shows immediately. */
export function drinkBarAddPhoto(id: string): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/jpeg,image/png,image/webp,image/gif';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('photo', file);
    try {
      const r = await fetch(`/api/drinks/${id}/photo`, { method: 'POST', body: fd, credentials: 'include' });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error || 'upload failed');
      toast('Photo added');
      await loadDrinks();
      renderDrinksBarTab();
    } catch (e: unknown) {
      toastError('Could not upload: ' + (e instanceof Error ? e.message : 'Unknown error'));
    }
  };
  input.click();
}

export async function drinkBarRemovePhoto(id: string): Promise<void> {
  try {
    await apiPost(`/api/drinks/${id}/photo`, {}, 'DELETE');
    toast('Photo removed');
    await loadDrinks();
    renderDrinksBarTab();
  } catch (e: unknown) {
    toastError('Could not remove: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}

export function openServiceCard(drinkId: string): void {
  const d = (S.drinks || []).find(x => x.id === drinkId);
  if (!d) return;
  const price = servePrice(d);
  const build = d.serviceInstructions || (d.prepSteps || []).join(' · ');
  const chips = (arr: string[]) => arr.map(x => `<span class="svc-chip">${esc(x)}</span>`).join('');
  showModal(`<div class="svc-card" data-testid="svc-card">
    <div class="svc-card-top">
      <h2>${esc(d.name)}</h2>
      ${price != null ? `<div class="svc-card-price">€${price.toFixed(2)}</div>` : ''}
    </div>
    <div class="svc-card-line">
      ${d.glass ? `<span><strong>Glass</strong> ${esc(d.glass)}</span>` : ''}
      ${d.serveVolumeMl ? `<span><strong>Serve</strong> ${d.serveVolumeMl} ml</span>` : ''}
      ${d.servingTemp ? `<span><strong>Temp</strong> ${esc(d.servingTemp)}</span>` : ''}
      ${d.abv ? `<span><strong>ABV</strong> ${d.abv}%</span>` : ''}
    </div>
    ${build ? `<div class="svc-card-build"><h3>Build</h3><p>${esc(build)}</p></div>` : ''}
    ${(d.garnish || []).length ? `<div class="svc-card-sub"><h3>Garnish</h3><div class="svc-chips">${chips(d.garnish)}</div></div>` : ''}
    ${(d.characteristics || []).length ? `<div class="svc-card-sub"><h3>Profile</h3><div class="svc-chips">${chips(d.characteristics)}</div></div>` : ''}
    <button class="btn svc-card-close" type="button" onclick="closeModal()">Done</button>
  </div>`);
}
