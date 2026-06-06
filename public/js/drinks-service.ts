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

function updateBarResults(): void {
  const wrap = document.getElementById('drinks-bar-results');
  if (!wrap) return;
  let list = barDrinks();
  if (_barCat !== 'all') list = list.filter(d => d.category === _barCat);
  const q = _barSearch.trim().toLowerCase();
  if (q) list = list.filter(d => d.name.toLowerCase().includes(q) || (d.subtype || '').toLowerCase().includes(q) || (d.characteristics || []).some(c => c.toLowerCase().includes(q)));
  if (list.length === 0) { wrap.innerHTML = `<div class="drinks-empty">No drinks${q ? ' match' : ' published for this bar'}.</div>`; return; }
  list = [...list].sort((a, b) => a.category === b.category ? a.name.localeCompare(b.name) : a.category.localeCompare(b.category));
  wrap.innerHTML = `<div class="svc-grid">${list.map(d => {
    const price = servePrice(d);
    return `<button class="svc-tile" data-testid="svc-tile" onclick="openServiceCard('${esc(d.id)}')">
      <span class="svc-tile-name">${esc(d.name)}</span>
      <span class="svc-tile-meta">${esc(drinkCategoryLabel(d.category))}${d.serveVolumeMl ? ` · ${d.serveVolumeMl}ml` : ''}</span>
      <span class="svc-tile-price">${price != null ? '€' + price.toFixed(2) : ''}</span>
    </button>`;
  }).join('')}</div>`;
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
