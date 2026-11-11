import test from 'node:test';
import assert from 'node:assert/strict';
import { patchBackgroundContent } from '../public/background-dom.js';

// Minimal DOM model for verifying identity and ordering without launching a desktop browser.
class Node {
  constructor(tag, attributes = {}, children = []) {
    this.nodeType = tag === '#text' ? 3 : 1;
    this.nodeName = this.tagName = tag.toUpperCase();
    this.values = new Map(Object.entries(attributes));
    this.childNodes = [];
    this.parentNode = null;
    this.nodeValue = '';
    this.style = { getPropertyValue: () => '', setProperty: () => {} };
    for (const child of children) this.insertBefore(child, null);
  }
  get id() { return this.getAttribute('id') || ''; }
  get attributes() { return [...this.values].map(([name, value]) => ({ name, value })); }
  get classList() {
    const node = this;
    return {
      *[Symbol.iterator]() { yield* (node.getAttribute('class') || '').split(' ').filter(Boolean); },
      add(name) { node.setAttribute('class', [...new Set([...node.classList, name])].join(' ')); },
    };
  }
  get firstChild() { return this.childNodes[0] || null; }
  get nextSibling() {
    const siblings = this.parentNode?.childNodes || [];
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  hasAttribute(name) { return this.values.has(name); }
  getAttribute(name) { return this.values.get(name) ?? null; }
  setAttribute(name, value) { this.values.set(name, String(value)); }
  removeAttribute(name) { this.values.delete(name); }
  insertBefore(child, before) {
    child.remove();
    const index = before ? this.childNodes.indexOf(before) : this.childNodes.length;
    assert.notEqual(index, -1);
    this.childNodes.splice(index, 0, child);
    child.parentNode = this;
  }
  remove() {
    if (this.parentNode) this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1);
    this.parentNode = null;
  }
}
const text = value => Object.assign(new Node('#text'), { nodeValue: value });

test('changed values keep dashboard, canvas, focusable input, and expanded details nodes', () => {
  const number = text('6');
  const canvas = new Node('canvas', { width: '400' });
  const input = new Node('input', { value: 'server' });
  input.value = 'unfinished draft';
  const details = new Node('details', { open: '' }, [new Node('summary', {}, [text('More')])]);
  const panel = new Node('div', { id: 'dashboard' }, [number, canvas, input, details]);
  const root = new Node('section', {}, [panel]);
  const next = new Node('section', {}, [new Node('div', { id: 'dashboard' }, [
    text('7'), new Node('canvas', { width: '400' }), new Node('input', { value: 'different' }),
    new Node('details', {}, [new Node('summary', {}, [text('More')])]),
  ])]);
  patchBackgroundContent(root, next);
  assert.equal(root.firstChild, panel);
  assert.equal(number.nodeValue, '7');
  assert.deepEqual(panel.childNodes, [number, canvas, input, details]);
  assert.equal(input.value, 'unfinished draft');
  assert.equal(details.hasAttribute('open'), true);
});

test('keyed rows retain identity when new data is inserted, removed, or reordered', () => {
  const first = new Node('div', { 'data-refresh-key': 'a' }, [text('old')]);
  const second = new Node('div', { 'data-refresh-key': 'b' });
  const removed = new Node('div', { 'data-refresh-key': 'removed' });
  const root = new Node('section', {}, [first, second, removed]);
  const added = new Node('div', { 'data-refresh-key': 'new' });
  patchBackgroundContent(root, new Node('section', {}, [
    added, new Node('div', { 'data-refresh-key': 'b' }),
    new Node('div', { 'data-refresh-key': 'a' }, [text('updated')]),
  ]));
  assert.deepEqual(root.childNodes, [added, second, first]);
  assert.equal(first.firstChild.nodeValue, 'updated');
  assert.equal(removed.parentNode, null);
});

test('updated handlers and server-disabled state apply to retained action buttons', () => {
  const button = new Node('button', { id: 'action' });
  let clicked = false;
  const nextButton = new Node('button', { id: 'action', disabled: '' });
  nextButton.onclick = () => { clicked = true; };
  const root = new Node('section', {}, [button]);
  patchBackgroundContent(root, new Node('section', {}, [nextButton]));
  assert.equal(root.firstChild, button);
  assert.equal(button.hasAttribute('disabled'), true);
  button.onclick();
  assert.equal(clicked, true);
});
