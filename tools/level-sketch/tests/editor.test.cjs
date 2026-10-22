// Run with: node --test tools/level-sketch/tests/editor.test.cjs
// Exercises real event handlers and persisted documents without dependencies.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const markup = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function setup(stored = null, failStorage = false) {
  let saved = stored, blob, confirmResult = true, frames = [];
  const noop = () => {};
  class Element {
    constructor(attributes = '') {
      this.handlers = {}; this.dataset = {}; this.style = {}; this.value = '';
      this.attributes = {}; this.hidden = false; this.files = [];
      const classes = new Set();
      this.classList = { add: (v) => classes.add(v), remove: (v) => classes.delete(v),
        toggle: (v, force) => { const on = force ?? !classes.has(v); on ? classes.add(v) : classes.delete(v); return on; } };
      for (const [, key, value] of attributes.matchAll(/([\w-]+)="([^"]*)"/g)) {
        this.attributes[key] = value;
        if (key === 'id') this.id = value;
        if (key === 'value') this.value = value;
        if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
      }
      this.context = new Proxy({}, { get: (target, key) => target[key] ?? noop, set: (t, k, v) => (t[k] = v, true) });
    }
    addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn); }
    async fire(type, data = {}) {
      for (const fn of this.handlers[type] || []) await fn({ target: this, preventDefault: noop, ...data });
    }
    click() { return this.fire('click'); }
    setAttribute(k, v) { this.attributes[k] = v; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 900, height: 640 }; }
    getContext() { return this.context; }
    setPointerCapture() {} hasPointerCapture() { return false; } releasePointerCapture() {}
    focus() {} append() {} remove() {} showModal() { this.open = true; } close() { this.open = false; }
  }
  const elements = [], byId = {};
  for (const [, attrs] of markup.matchAll(/<[a-z][a-z\d-]*\b([^>]*)>/gi)) {
    const element = new Element(attrs); elements.push(element);
    if (element.id) byId[element.id] = element;
  }
  const document = new Element();
  document.getElementById = (id) => byId[id];
  document.querySelectorAll = (selectors) => elements.filter((el) => selectors.split(',').some((selector) => {
    selector = selector.trim();
    if (selector.startsWith('.')) return (el.attributes.class || '').split(' ').includes(selector.slice(1));
    return selector.startsWith('[') && selector.slice(1, -1) in el.attributes;
  }));
  document.createElement = () => new Element(); document.body = new Element();
  const window = new Element(); window.devicePixelRatio = 1; window.confirm = () => confirmResult;
  const db = { close: noop, transaction: () => {
    const tx = { objectStore: () => ({
      get: () => { const request = {}; queueMicrotask(() => { request.result = saved; request.onsuccess(); }); return request; },
      put: (data) => { saved = structuredClone(data); queueMicrotask(() => tx.oncomplete?.()); }
    }) }; return tx;
  } };
  const indexedDB = { open: () => {
    const request = {};
    queueMicrotask(() => {
      if (failStorage) request.onerror();
      else { request.result = db; request.onsuccess(); }
    }); return request;
  } };
  // Timers are held so tests do not leave autosave/toast timers running. Stroke
  // commits save immediately; reload tests use the same structured-cloned data.
  const sandbox = { document, window, indexedDB, Blob, console, ResizeObserver: class { observe() {} },
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    setTimeout: () => 1, clearTimeout: noop,
    URL: { createObjectURL: (value) => { blob = value; return 'blob:test'; }, revokeObjectURL: noop } };
  vm.runInNewContext(source, sandbox, { filename: 'app.js' });
  await settle();
  const frame = () => { const pending = frames; frames = []; pending.forEach((fn) => fn()); };
  frame();
  const pointer = async (type, x, y, id = 1, extra = {}) => {
    await byId['map-canvas'].fire(type, { clientX: x, clientY: y, pointerId: id, pointerType: 'touch', button: 0, ...extra });
    frame();
  };
  const stroke = async (a, b) => {
    await pointer('pointerdown', ...a); await pointer('pointermove', ...b); await pointer('pointerup', ...b); await settle();
  };
  return { byId, pointer, stroke, frame, window, document,
    saved: () => saved, blob: () => blob, confirm: (v) => { confirmResult = v; },
    choose: async (attribute, value) => {
      const el = elements.find((e) => e.attributes[attribute] === value); assert.ok(el); await el.click(); frame();
    } };
}

test('rectangles snap in both directions, persist, and restore after reopening', async () => {
  const app = await setup();
  await app.stroke([300, 240], [410, 320]);
  await app.stroke([550, 420], [470, 350]);
  const saved = app.saved(); assert.equal(saved.operations.length, 2);
  for (const op of saved.operations) {
    assert.equal(op.tool, 'rect'); assert.equal(op.action, 'remove');
    for (const key of ['x', 'y', 'w', 'h']) assert.equal(op[key] % 32, 0);
    assert.ok(op.w > 0 && op.h > 0 && op.x + op.w <= 4096 && op.y + op.h <= 2560);
  }
  const restored = await setup(saved);
  assert.equal(restored.byId['empty-hint'].hidden, true);
  await restored.byId['export-json'].click();
  assert.equal(JSON.parse(await restored.blob().text()).operations.length, 2);
});

test('terrain and decoration stay independent; undo/redo persists the final branch', async () => {
  const app = await setup();
  await app.stroke([300, 240], [410, 320]);
  await app.choose('data-action', 'decorate'); await app.stroke([300, 240], [400, 310]);
  await app.choose('data-action', 'fill'); await app.stroke([320, 250], [340, 270]);
  assert.deepEqual(app.saved().operations.map((o) => o.action), ['remove', 'decorate', 'fill']);
  await app.byId.undo.click(); await settle(); assert.equal(app.saved().operations.length, 2);
  await app.byId.redo.click(); await settle(); assert.equal(app.saved().operations.length, 3);
  await app.byId.undo.click(); await app.stroke([340, 250], [370, 280]);
  assert.equal(app.byId.redo.disabled, true);
  assert.deepEqual(app.saved().operations.map((o) => o.action), ['remove', 'decorate', 'fill']);
});

test('two-finger navigation cancels tentative drawing and leaves no accidental marks', async () => {
  const app = await setup();
  await app.pointer('pointerdown', 300, 240, 1);
  await app.pointer('pointermove', 350, 280, 1);
  await app.pointer('pointerdown', 500, 400, 2);
  await app.pointer('pointermove', 580, 450, 2);
  await app.pointer('pointerup', 580, 450, 2);
  await app.pointer('pointermove', 320, 260, 1);
  await app.pointer('pointerup', 320, 260, 1);
  await app.byId['export-json'].click();
  assert.equal(JSON.parse(await app.blob().text()).operations.length, 0);
  assert.equal(app.byId.undo.disabled, true);
});

test('canceled touches do not commit; square and smoothed round brushes are editable commands', async () => {
  const app = await setup();
  await app.pointer('pointerdown', 300, 240); await app.pointer('pointercancel', 340, 280);
  assert.equal(app.byId.undo.disabled, true);
  await app.choose('data-tool', 'square'); await app.stroke([300, 240], [420, 350]);
  await app.choose('data-tool', 'round'); await app.stroke([440, 350], [510, 420]);
  assert.deepEqual(app.saved().operations.map((o) => o.tool), ['square', 'round']);
  assert.equal(app.saved().operations[0].size % 32, 0);
  assert.ok(app.saved().operations[1].points.length >= 2);
});

test('invalid backups leave the current map intact; valid backups can be canceled', async () => {
  const app = await setup(); await app.stroke([300, 240], [410, 320]);
  const before = JSON.stringify(app.saved());
  app.byId['import-file'].files = [{ size: 10, text: async () => '{"format":"broken"}' }];
  await app.byId['import-file'].fire('change');
  assert.equal(JSON.stringify(app.saved()), before);
  const invalid = structuredClone(app.saved()); invalid.operations[0].w = Infinity;
  app.byId['import-file'].files = [{ size: 100, text: async () => JSON.stringify(invalid) }];
  await app.byId['import-file'].fire('change'); assert.equal(JSON.stringify(app.saved()), before);
  const valid = structuredClone(app.saved()); valid.name = 'Backup de teste';
  app.confirm(false);
  app.byId['import-file'].files = [{ size: 100, text: async () => JSON.stringify(valid) }];
  await app.byId['import-file'].fire('change'); assert.equal(JSON.stringify(app.saved()), before);
  app.confirm(true); await app.byId['import-file'].fire('change'); await settle();
  assert.equal(app.saved().name, 'Backup de teste');
});

test('storage unavailable still allows drawing and exporting, with an honest status', async () => {
  const app = await setup(null, true); await app.stroke([300, 240], [410, 320]);
  assert.equal(app.byId['save-state'].dataset.state, 'error');
  await app.byId['export-json'].click();
  assert.equal(JSON.parse(await app.blob().text()).operations.length, 1);
});
