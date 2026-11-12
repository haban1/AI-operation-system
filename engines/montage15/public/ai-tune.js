/* AI 调整：把“重新生成部分内容”和“自然语言调整”合成一个面板。
   - 一个范围选择 + 一个输入框 + 一个按钮；输入框留空 = 在该范围重新生成，有描述 = 按描述修改。
   - 实际执行仍由原来的 #ai-regenerate / #ai-adjust 完成（保留在隐藏区域），AI 任务、锁定与接口逻辑不变。 */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);

  const selectedShot = () => {
    const shots = [...document.querySelectorAll('#shot-timeline [data-slot-id]')];
    const index = shots.findIndex(item => item.classList.contains('selected'));
    return index < 0 ? null : { index, id: shots[index].dataset.slotId };
  };

  function update() {
    const scope = $('ai-tune-scope'), run = $('ai-tune-run');
    if (!scope || !run) return;
    const shot = selectedShot();
    const option = scope.querySelector('option[value=selected]');
    if (option) { option.textContent = shot ? `当前选中的镜头（镜头 ${shot.index + 1}）` : '当前选中的镜头'; option.disabled = !shot; }
    if (scope.value === 'selected' && !shot) scope.value = 'auto';
    const text = $('ai-instruction').value.trim();
    run.textContent = text ? '按描述修改' : '重新生成';
    const hints = {
      auto: text ? 'AI 根据描述判断要改哪里；描述里点名的镜头之外保持不变。' : '重新生成所有未锁定的镜头、文案和音乐。',
      selected: shot ? `只改镜头 ${shot.index + 1}，其他镜头、文案和音乐保持不变。` : '先在时间轴上点选一个镜头。',
      fields: '只改文案，镜头和音乐保持不变。也可以在时间轴的“文案”行里单独改某一句。',
      audio: '只改音乐与音量，画面和文案保持不变。',
    };
    $('ai-scope-hint').textContent = hints[scope.value] + ' 已锁定的内容不会被改动。';
    const busy = $('ai-adjust')?.disabled;
    scope.disabled = !!busy; run.disabled = !!busy || (scope.value === 'selected' && !shot);
  }

  function execute() {
    const value = $('ai-tune-scope').value;
    const text = $('ai-instruction').value.trim();
    if (text) {
      // 按描述修改：映射到原“修改范围”
      $('ai-adjust-scope').value = { auto: 'instruction', selected: 'selected', fields: 'fields', audio: 'audio' }[value];
      $('ai-adjust').click();
      return;
    }
    // 重新生成：映射到原“重新生成范围”
    const shot = selectedShot();
    const target = value === 'auto' ? 'all' : value === 'selected' ? shot?.id : value;
    if (!target || ![...$('ai-scope').options].some(option => option.value === target)) return;
    $('ai-scope').value = target;
    $('ai-regenerate').click();
  }

  function start() {
    if (!$('ai-tune')) return;
    $('ai-tune-scope').addEventListener('change', update);
    $('ai-instruction').addEventListener('input', update);
    $('ai-tune-run').addEventListener('click', execute);
    $('ai-tune').addEventListener('toggle', () => { if ($('ai-tune').open) { update(); $('ai-instruction').focus({ preventScroll: true }); } });
    // 选中镜头、AI 任务开始 / 结束时同步按钮和提示
    const observer = new MutationObserver(update);
    observer.observe($('shot-timeline'), { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    observer.observe($('ai-adjust'), { attributes: true, attributeFilter: ['disabled'] });
    update();
  }

  // 原代码在渲染镜头面板时会改写提示文字，渲染后再写回统一面板的提示
  const P = window.MontageWorkspace?.prototype;
  if (P?.renderShot) {
    const renderShot = P.renderShot;
    P.renderShot = function (...args) { const result = renderShot.apply(this, args); update(); return result; };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
