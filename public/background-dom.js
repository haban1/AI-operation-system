// Reconcile background data while retaining focus, disclosure state, and canvas nodes.
function nodeKey(node) {
  if (node.nodeType !== 1) return node.nodeName;
  if (node.id) return `id:${node.id}`;
  if (node.hasAttribute('data-refresh-key')) return `key:${node.getAttribute('data-refresh-key')}`;
  const classes = [...node.classList].filter(name => !/^(?:is-|has-|tk-|v2-tone-|active$|running$|stopped$|warning$|success$|danger$|planned$|online$|offline$)/.test(name));
  const identity = node.getAttribute('name') || (node.tagName === 'OPTION' ? node.getAttribute('value') : '') || '';
  return `${node.nodeName}:${classes.join('.')}:${identity}`;
}

function patchNode(current, next) {
  if (current.nodeType !== 1) {
    if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
    return;
  }
  const preserved = new Set(current.tagName === 'DETAILS' ? ['open'] : []);
  if (['INPUT', 'TEXTAREA', 'SELECT', 'OPTION'].includes(current.tagName)) {
    for (const name of ['value', 'checked', 'selected']) preserved.add(name);
  }
  const localStyle = ['--mx', '--my', '--gx', 'transform'].map(name => [name, current.style.getPropertyValue(name)]).filter(([, value]) => value);
  const localClasses = [...current.classList].filter(name => name.startsWith('tk-'));
  for (const attribute of [...current.attributes]) {
    if (!preserved.has(attribute.name) && !next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
  }
  for (const attribute of next.attributes) {
    if (!preserved.has(attribute.name) && current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
  }
  for (const name of localClasses) current.classList.add(name);
  for (const [name, value] of localStyle) current.style.setProperty(name, value);
  for (const event of ['onclick', 'onchange', 'oninput', 'onkeydown']) {
    if (next[event]) current[event] = next[event];
  }
  if (['CANVAS', 'INPUT', 'TEXTAREA', 'SELECT'].includes(current.tagName)) return;
  patchBackgroundContent(current, next);
}

export function patchBackgroundContent(current, next) {
  const previous = [...current.childNodes];
  const used = new Set();
  let cursor = current.firstChild;
  for (const child of [...next.childNodes]) {
    const key = nodeKey(child);
    const match = previous.find(node => !used.has(node) && node.nodeType === child.nodeType && node.nodeName === child.nodeName && nodeKey(node) === key);
    if (match) {
      used.add(match);
      if (match !== cursor) current.insertBefore(match, cursor);
      patchNode(match, child);
      cursor = match.nextSibling;
    } else {
      current.insertBefore(child, cursor);
    }
  }
  for (const node of previous) {
    if (!used.has(node)) node.remove();
  }
}
