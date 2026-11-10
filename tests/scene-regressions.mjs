import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as THREE from '../vendor/three/three.module.js';
import * as ui from '../static/js/ui.js';

// Actual scene methods and local three.js; only browser/IO boundaries are substituted.
const sceneSource = await readFile(new URL('../static/js/scene.js', import.meta.url), 'utf8');
const buildingSource = await readFile(new URL('../static/js/buildings.js', import.meta.url), 'utf8');
const strip = (source) => source.replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function element() {
  const classes = new Set();
  return {
    innerHTML: '', textContent: '', style: {}, dataset: {}, children: [], isConnected: true,
    offsetWidth: 125, offsetHeight: 24, clientWidth: 1000, clientHeight: 700,
    attributes: {}, listeners: {},
    classList: { contains: (x) => classes.has(x), add: (...xs) => xs.forEach((x) => classes.add(x)), remove: (...xs) => xs.forEach((x) => classes.delete(x)), toggle(x, on = !classes.has(x)) { if (on) classes.add(x); else classes.delete(x); return on; } },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    addEventListener(k, fn) { this.listeners[k] = fn; },
    querySelectorAll() { return []; }, querySelector() { return null; },
    contains() { return false; }, focus() {},
  };
}
function harness() {
  const nodes = new Map();
  const $ = (key) => { if (!nodes.has(key)) nodes.set(key, element()); return nodes.get(key); };
  const raf = new Map();
  let frameId = 0;
  const messages = [];
  const loads = [];
  const api = { models: async () => ({ models: [] }), buildings: async () => ({ buildings: [] }) };
  class SplatMesh extends THREE.Group {
    constructor() { super(); this.worker = { addEventListener() {} }; this.request = deferred(); loads.push(this); }
    load() { return this.request.promise; }
    dispose() { this.disposed = true; }
  }
  const document = { hidden: false, activeElement: null, addEventListener() {}, querySelector: $, querySelectorAll: () => [] };
  const window = { listeners: {}, addEventListener(k, fn) { this.listeners[k] = fn; } };
  const context = vm.createContext({
    ...ui, THREE, $, $$: () => [], api, SplatMesh, document,
    performance, AbortController, URL, console, Event,
    location: { hash: '#/scene', href: 'http://localhost/#/scene' },
    history: { replaceState() {} }, window,
    localStorage: { getItem: () => null, setItem() {} },
    toast: (...args) => messages.push(args),
    requestAnimationFrame: (fn) => { raf.set(++frameId, fn); return frameId; },
    cancelAnimationFrame: (id) => raf.delete(id),
  });
  vm.runInContext(strip(buildingSource) + ';globalThis.BuildingLayer = BuildingLayer;', context);
  vm.runInContext(strip(sceneSource) + ';globalThis.SceneView = SceneView;', context);
  const view = new context.SceneView();
  view.renderer = { domElement: element(), render() {} };
  view.scene = new THREE.Scene();
  view.buildings = new context.BuildingLayer();
  view.measureGroup = new THREE.Group();
  view.camera = new THREE.PerspectiveCamera(50, 1000 / 700, 0.1, 5000);
  view.camera.position.set(0, -100, 100);
  view.camera.up.set(0, 0, 1);
  view.camera.lookAt(0, 0, 0);
  view.camera.updateMatrixWorld();
  view.controls = { target: new THREE.Vector3(), autoRotate: false, update: () => false };
  view.host = element();
  view.stars = { visible: false, update() {} };
  view.grid = { visible: false, update() {} };
  view.dust = { visible: false, update() {} };
  return { view, $, context, nodes, raf, api, loads, messages };
}
const building = { id: 0, ring: [[0, 0], [12, 0], [12, 8], [0, 8]], base: 0, top: 10, height_m: 10 };

test('overview limits 142 tags and gives an overlapping selected building priority', () => {
  const { view, $ } = harness();
  const tags = Array.from({ length: 142 }, () => element());
  $('#building-tags').children = tags;
  view.buildings.items = tags.map((_, i) => ({ data: { id: i }, topCenter: new THREE.Vector3((i % 10 - 5) * 3, Math.floor(i / 10) * 2, 0) }));
  view.buildings.selected = 141;
  view.buildings.items[141].topCenter.copy(view.buildings.items[0].topCenter);
  view._updateTags();
  const visible = tags.filter((el) => el.style.display !== 'none');
  assert.ok(visible.length <= 12, visible.length + ' labels in overview');
  assert.notEqual(tags[141].style.display, 'none');
  assert.equal(tags[0].style.display, 'none');
  for (let a = 0; a < visible.length; a++) for (let b = a + 1; b < visible.length; b++) {
    const dx = Math.abs(parseFloat(visible[a].style.left) - parseFloat(visible[b].style.left));
    const dy = Math.abs(parseFloat(visible[a].style.top) - parseFloat(visible[b].style.top));
    assert.ok(dx >= 125 || dy >= 24, 'visible labels overlap');
  }
});

test('rebuilding tags synchronizes a previously hidden layer container', () => {
  const { view, $ } = harness();
  $('#building-tags').classList.add('hidden');
  view.buildings.visible = true;
  view._renderTags();
  assert.equal($('#building-tags').classList.contains('hidden'), false);
});

test('late catalog lookup cannot overwrite a newer model selection', async () => {
  const { view, api, loads } = harness();
  const lookup = deferred();
  api.models = () => lookup.promise;
  const known = { file: 'new.splat', stem: 'new' };
  const old = { file: 'old.splat', stem: 'old' };
  view.models = [known];
  const first = view.open(old.file);
  const second = view.open(known.file);
  lookup.resolve({ models: [old, known] });
  await new Promise(setImmediate);
  for (const load of loads) load.request.resolve(null);
  await Promise.all([first, second]);
  assert.equal(view.current, known.file);
  assert.equal(loads.length, 1);
});

test('switching away disposes a model still being parsed', async () => {
  const { view, loads } = harness();
  view.models = [{ file: 'a.splat' }, { file: 'b.splat' }];
  const first = view.open('a.splat');
  const old = loads[0];
  const second = view.open('b.splat');
  const disposed = old.disposed;
  loads.forEach((m) => m.request.resolve(null));
  await Promise.all([first, second]);
  assert.equal(disposed, true);
});

test('a measurement result from a previous model is ignored', async () => {
  const { view } = harness();
  const pick = deferred();
  view.measureMode = true;
  view.splat = { pick: () => pick.promise };
  view.raycaster = { setFromCamera() {}, ray: {} };
  view._ndc = () => new THREE.Vector2();
  let added = 0;
  view._addMeasurePoint = () => added++;
  const pending = view._click({});
  view.loadToken++;
  view.splat = {};
  pick.resolve(new THREE.Vector3());
  await pending;
  assert.equal(added, 0);
});

test('disposed worker rejection during focus does not escape', async () => {
  const { view, messages } = harness();
  const pick = deferred();
  view.splat = { pick: () => pick.promise };
  view.raycaster = { setFromCamera() {}, ray: {} };
  view._ndc = () => new THREE.Vector2();
  const pending = view._focusAt({});
  view.loadToken++;
  view.splat = null;
  pick.reject(new Error('disposed'));
  await assert.doesNotReject(pending);
  assert.equal(messages.length, 0);
});

test('hidden scene stops scheduling animation frames', () => {
  const { view, raf } = harness();
  view.active = false;
  view._animate();
  assert.equal(raf.size, 0);
});

test('hidden browser document stops scheduling animation frames', () => {
  const { view, context, raf } = harness();
  context.document.hidden = true;
  view._animate();
  assert.equal(raf.size, 0);
});

test('setActive(false) cancels an outstanding frame', () => {
  const { view, context, raf } = harness();
  view.raf = context.requestAnimationFrame(() => {});
  view.setActive(false);
  assert.equal(raf.size, 0);
});

test('fina keeps zero alignment and rejects malformed saved offsets', async () => {
  const { view, api, context } = harness();
  view.current = 'fina.splat';
  api.buildings = async () => ({ aligned: true, buildings: [building] });
  context.localStorage.getItem = () => '[1,null]';
  view._renderBuildingPanel = () => {};
  view._renderTags = () => {};
  await view._loadBuildings({ stem: 'fina' });
  assert.deepEqual(view.buildings.offset.toArray(), [0, 0, 0]);
  assert.equal(view._alignKey(), 'twin.align.fina.splat.fina');
});

test('OSM-only evidence is not reported as empty; matching and raw score stay visible', async () => {
  const { view, $, context } = harness();
  view.buildingsData = { evidence_api: '/api/evidence/fina' };
  context.fetch = async () => ({ ok: true, json: async () => ({ id: 0, name: 'Evidence name', sidecar_name: 'Model name', name_match: false, matched_by: 'agent_bid', score: 0, match: 'context', osm: { building: 'yes' }, images: [], links: [], quotes: [] }) });
  await view._loadEvidence({ id: 0 });
  const html = $('#bld-ev').innerHTML;
  assert.doesNotMatch(html, /没有可展示/);
  assert.match(html, /agent_bid/);
  assert.match(html, /Model name/);
  assert.match(html, /不一致/);
  assert.match(html, /评分 0/);
  assert.doesNotMatch(html, /置信/);
});

test('empty evidence score is not converted to zero', async () => {
  const { view, $, context } = harness();
  view.buildingsData = { evidence_api: '/api/evidence/fina' };
  context.fetch = async () => ({ ok: true, json: async () => ({ score: '', images: [], links: [], quotes: [] }) });
  await view._loadEvidence({ id: 0 });
  assert.doesNotMatch($('#bld-ev').innerHTML, /(?:置信|评分) 0/);
});

test('street view considers the closing edge of an unclosed footprint', () => {
  const { view } = harness();
  view.buildings.setData([{ ...building, ring: [[0, 0], [1, 0], [1, 10], [0, 20]] }]);
  let pose;
  view.flyTo = (eye, target) => { pose = { eye, target }; };
  view.streetView(0);
  assert.ok(pose.eye.x < 0, 'camera should face the longest (left/closing) facade');
  assert.equal(pose.eye.y, 10);
});

test('model cards can be opened using Enter and Space', () => {
  const { view, $ } = harness();
  view._bindUI();
  const opened = [];
  view.open = (file) => opened.push(file);
  const keydown = $('#model-list').listeners.keydown;
  assert.equal(typeof keydown, 'function');
  for (const key of ['Enter', ' ']) keydown({ key, target: { closest: () => ({ dataset: { file: 'fina.splat' } }) }, preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(opened, ['fina.splat', 'fina.splat']);
});

test('Space on an interactive control does not trigger global orbit', () => {
  const { view, context } = harness();
  view._bindUI();
  const actions = [];
  view._action = (action) => actions.push(action);
  context.window.listeners.keydown({ key: ' ', target: { matches: () => false, closest: () => ({ tagName: 'BUTTON' }) }, preventDefault() {} });
  assert.deepEqual(actions, []);
});

test('view buttons before model load cannot send the camera to an invalid pose', () => {
  const { view, messages } = harness();
  let flights = 0;
  view.flyTo = () => flights++;
  view._action('top');
  assert.equal(flights, 0);
  assert.ok(messages.length > 0);
});

test('disabled layer gives feedback and clears its hover immediately', () => {
  const { view, $ } = harness();
  view.buildings.setData([building]);
  view._setHover(0);
  const button = $('#toolbar [data-act="buildings"]');
  button.classList.add('on');
  view._action('buildings', button);
  assert.equal(view.hover.idx, -1);
  assert.equal(button.attributes['aria-pressed'], 'false');
  assert.equal($('#building-tags').classList.contains('hidden'), true);
});

test('Space on a disclosure summary retains native expand/collapse behavior', () => {
  const { view, context } = harness();
  view._bindUI();
  let intercepted = false;
  context.window.listeners.keydown({ key: ' ', target: { closest: (selector) => selector.split(',').some((s) => s.trim() === 'summary') ? {} : null }, preventDefault() { intercepted = true; } });
  assert.equal(intercepted, false);
});
