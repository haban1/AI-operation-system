(() => {
  const root = document.documentElement;
  const frame = document.getElementById('automaticFrame');
  if (!frame || !document.querySelector('.studio-topbar')) return;
  let childRoot, resize, pending = 0;
  const isAutomatic = () => document.body.dataset.studioView === 'automatic';
  const measure = () => {
    pending = 0;
    if (!isAutomatic() || !childRoot?.isConnected) return;
    const body = childRoot.ownerDocument.body;
    if (!body) return;
    const height = Math.ceil(Math.max(body.getBoundingClientRect().height, body.scrollHeight));
    if (height > 0 && frame.style.height !== `${height}px`) frame.style.height = `${height}px`;
  };
  const schedule = () => { if (!pending) pending = requestAnimationFrame(measure); };
  const bind = () => {
    let doc;
    try { doc = frame.contentDocument; } catch { return; }
    if (!doc?.body || doc.documentElement === childRoot) return;
    resize?.disconnect();
    childRoot?.removeAttribute('data-creation-page-scroll');
    childRoot = doc.documentElement;
    if (isAutomatic()) childRoot.setAttribute('data-creation-page-scroll', '');
    resize = new ResizeObserver(schedule);
    resize.observe(doc.body);
    schedule();
  };
  const update = () => {
    const view = document.body.dataset.studioView;
    root.classList.toggle('creation-page-scroll', view === 'automatic' || view === 'materials');
    bind();
    if (childRoot) childRoot.toggleAttribute('data-creation-page-scroll', isAutomatic());
    if (isAutomatic()) schedule();
    else frame.style.removeProperty('height');
  };
  const route = new MutationObserver(update);
  route.observe(document.body, { attributes: true, attributeFilter: ['data-studio-view'] });
  frame.addEventListener('load', update);
  window.addEventListener('resize', schedule);
  window.addEventListener('pagehide', () => {
    route.disconnect(); resize?.disconnect(); cancelAnimationFrame(pending);
  }, { once: true });
  update();
})();
