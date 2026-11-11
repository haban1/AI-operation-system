/* 下拉框外观：把原生 <select> 包成 macOS 风格的弹出菜单。
   - 原生 select 仍在原位（透明、可聚焦），键盘、读屏和 app.js 的 onchange 逻辑照旧使用它；
   - 鼠标点外观按钮弹出菜单，选中后设置 select.value 并派发 change 事件；
   - 页面重绘或后台原位合并后，由 MutationObserver 重新挂上外观（在同一帧内完成）。 */
import { PLATFORM_BRANDS, platformLogo } from './platform-icons.js?v=20261111-v2';

const CHEVRON = '<svg viewBox="0 0 12 16" aria-hidden="true"><path d="M3 6l3-3 3 3M3 10l3 3 3-3"/></svg>';
const CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>';
let openMenu = null;

function optionIcon(value) {
  if (PLATFORM_BRANDS[value]) return platformLogo(value, 18);
  return '';
}
function labelOf(select) {
  const option = select.options[select.selectedIndex];
  return option ? option.textContent.trim() : '';
}
function sync(select) {
  const wrap = select.parentElement;
  if (!wrap?.classList.contains('ui-select')) return;
  const button = wrap.querySelector(':scope > .ui-select-button');
  if (!button) return;
  const value = select.value, label = labelOf(select), disabled = select.disabled;
  // 只在内容变化时写入，避免与 MutationObserver 互相触发
  if (button.dataset.value === value && button.dataset.label === label && button.disabled === disabled) return;
  button.dataset.value = value; button.dataset.label = label;
  button.querySelector('.ui-select-icon').innerHTML = optionIcon(value);
  button.querySelector('.ui-select-label').textContent = label;
  button.disabled = disabled;
  wrap.classList.toggle('is-disabled', disabled);
}
function closeMenu() {
  if (!openMenu) return;
  const { menu, button, cleanup } = openMenu;
  openMenu = null;
  cleanup();
  button.setAttribute('aria-expanded', 'false');
  menu.classList.add('is-closing');
  setTimeout(() => menu.remove(), 110);
}
function choose(select, index) {
  if (select.selectedIndex !== index) {
    select.selectedIndex = index;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  sync(select);
}
function open(select, button) {
  if (openMenu?.button === button) { closeMenu(); return; }
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'ui-select-menu';
  menu.setAttribute('role', 'listbox');
  const items = [...select.options].map((option, index) => {
    const item = document.createElement('div');
    item.className = 'ui-select-item';
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(index === select.selectedIndex));
    if (option.disabled) item.setAttribute('aria-disabled', 'true');
    item.innerHTML = `<span class="ui-select-check">${index === select.selectedIndex ? CHECK : ''}</span><span class="ui-select-icon">${optionIcon(option.value)}</span><span class="ui-select-text"></span>`;
    item.querySelector('.ui-select-text').textContent = option.textContent.trim();
    item.onmouseenter = () => focusItem(index);
    item.onclick = () => { if (option.disabled) return; choose(select, index); closeMenu(); select.focus({ preventScroll: true }); };
    menu.append(item);
    return item;
  });
  let active = Math.max(0, select.selectedIndex);
  const focusItem = index => { active = index; items.forEach((item, i) => item.classList.toggle('is-active', i === index)); items[index]?.scrollIntoView({ block: 'nearest' }); };
  document.body.append(menu);
  const place = () => {
    const r = button.getBoundingClientRect();
    menu.style.minWidth = `${Math.max(r.width, 160)}px`;
    const height = menu.offsetHeight, below = innerHeight - r.bottom - 8, above = r.top - 8;
    const up = height > below && above > below;
    menu.style.left = `${Math.min(Math.max(8, r.left), innerWidth - menu.offsetWidth - 8)}px`;
    menu.style.top = `${up ? Math.max(8, r.top - height - 6) : r.bottom + 6}px`;
    menu.style.maxHeight = `${Math.max(160, (up ? above : below) - 6)}px`;
    menu.classList.toggle('is-up', up);
  };
  place();
  focusItem(active);
  const onKey = event => {
    if (event.key === 'Escape') { event.preventDefault(); closeMenu(); button.focus(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); focusItem(Math.min(items.length - 1, active + 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); focusItem(Math.max(0, active - 1)); }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); items[active]?.click(); }
    else if (event.key === 'Tab') closeMenu();
  };
  const onPointer = event => { if (!menu.contains(event.target) && !button.contains(event.target)) closeMenu(); };
  const onScroll = event => { if (!menu.contains(event.target)) closeMenu(); };
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onPointer, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', closeMenu);
  openMenu = { menu, button, cleanup() {
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onPointer, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', closeMenu);
  } };
  button.setAttribute('aria-expanded', 'true');
}
function enhance(select) {
  if (select.multiple || select.size > 1 || select.closest('.ui-select') || select.dataset.native === 'true') return;
  const wrap = document.createElement('span');
  wrap.className = 'ui-select';
  select.before(wrap);
  wrap.append(select);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ui-select-button';
  button.tabIndex = -1;
  button.setAttribute('aria-hidden', 'true');
  button.setAttribute('aria-haspopup', 'listbox');
  button.innerHTML = `<span class="ui-select-icon"></span><span class="ui-select-label"></span><span class="ui-select-chevron">${CHEVRON}</span>`;
  button.onclick = event => { event.preventDefault(); if (!select.disabled) open(select, button); };
  wrap.append(button);
  if (!select.dataset.uiSelectBound) {
    select.dataset.uiSelectBound = 'true';
    select.addEventListener('change', () => sync(select));
  }
  sync(select);
}
function scan(root) {
  if (root.nodeType !== 1) return;
  if (root.tagName === 'SELECT') enhance(root);
  else root.querySelectorAll?.('select').forEach(enhance);
}
export function startSelectEnhancer() {
  scan(document.body);
  new MutationObserver(records => {
    for (const record of records) {
      record.addedNodes.forEach(scan);
      if (record.type === 'attributes' && record.target.tagName === 'SELECT') sync(record.target);
    }
    // 后台合并会把外观节点移除或把 select 移出包裹层，这里补回
    document.querySelectorAll('select').forEach(select => { if (!select.closest('.ui-select')) enhance(select); else sync(select); });
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
}
