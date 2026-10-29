import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/content-library-picker.js', import.meta.url), 'utf8');
const materialId = 'a'.repeat(32);

function pickerHarness() {
  const listeners = new Set();
  const dialogs = [];
  const context = vm.createContext({
    location: { origin: 'http://localhost:3100' },
    window: {
      addEventListener: (type, listener) => { if (type === 'message') listeners.add(listener); },
      removeEventListener: (type, listener) => { if (type === 'message') listeners.delete(listener); },
    },
    document: {
      createElement() {
        const frame = { contentWindow: {} }, button = {}, events = new Map();
        const dialog = {
          isConnected: false, open: false, frame,
          setAttribute() {},
          querySelector: selector => selector === 'iframe' ? frame : button,
          addEventListener: (type, listener) => events.set(type, listener),
          showModal() { this.open = true; },
          // Native close events are queued, so two messages can arrive first.
          close() { this.open = false; },
          flushClose() { events.get('close')?.(); },
          remove() { this.isConnected = false; },
        };
        dialogs.push(dialog);
        return dialog;
      },
      body: { append: dialog => { dialog.isConnected = true; } },
    },
  });
  vm.runInContext(source.replaceAll('export function ', 'function '), context);
  return {
    open: options => { context.openContentLibraryPicker(options); return dialogs.at(-1); },
    message: (dialog, data, overrides = {}) => {
      const event = { origin: context.location.origin, source: dialog.frame.contentWindow, data, ...overrides };
      for (const listener of listeners) listener(event);
    },
    listeners,
  };
}

test('picker only hands a valid material ID from its own same-origin frame to publishing', () => {
  const harness = pickerHarness(), selected = [];
  const dialog = harness.open({ onSelect: id => selected.push(id) });
  const data = { type: 'content-library:publish', id: materialId };
  harness.message(dialog, data, { origin: 'https://untrusted.example' });
  harness.message(dialog, data, { source: {} });
  harness.message(dialog, { ...data, id: '../../private-file' });
  harness.message(dialog, { ...data, id: 'v5-01' });
  assert.deepEqual(selected, []);
  assert.equal(dialog.open, true);
  harness.message(dialog, data);
  assert.deepEqual(selected, [materialId]);
  assert.equal(dialog.open, false);
  harness.message(dialog, data);
  assert.deepEqual(selected, [materialId], 'queued duplicate messages must not hand off twice');
  dialog.flushClose();
  assert.equal(harness.listeners.size, 0);
});

test('picker reauthentication closes without selecting a material', () => {
  const harness = pickerHarness(), selected = [];
  let unauthorized = 0;
  const dialog = harness.open({ onSelect: id => selected.push(id), onUnauthorized: () => unauthorized++ });
  harness.message(dialog, { type: 'content-workbench:unauthorized' });
  harness.message(dialog, { type: 'content-library:publish', id: materialId });
  assert.equal(unauthorized, 1);
  assert.deepEqual(selected, []);
  assert.equal(dialog.open, false);
});

test('a replaced picker cannot select from its stale frame while its close event is queued', () => {
  const harness = pickerHarness(), selected = [];
  const previous = harness.open({ onSelect: id => selected.push(`previous:${id}`) });
  const current = harness.open({ onSelect: id => selected.push(id) });
  const message = { type: 'content-library:publish', id: materialId };
  harness.message(previous, message);
  assert.deepEqual(selected, []);
  previous.flushClose();
  harness.message(current, message);
  assert.deepEqual(selected, [materialId]);
});
