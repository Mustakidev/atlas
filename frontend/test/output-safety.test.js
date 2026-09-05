const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const frontendDir = path.join(__dirname, '..');
const appSource = fs.readFileSync(path.join(frontendDir, 'app.js'), 'utf8');

const PAYLOADS = [
  '<img src=x onerror="window.__atlas_xss_probe=1">',
  '<script>window.__atlas_xss_probe=1</script>',
  '"><svg onload="window.__atlas_xss_probe=1">',
  '& < > " \'',
];

class DomNode {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.className = '';
    this.style = {};
    this._text = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.listeners = {};
  }

  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }

  get textContent() {
    return this._text + this.children.map(child => child.textContent).join('');
  }

  get firstChild() {
    return this.children[0] || null;
  }

  get classList() {
    const node = this;
    return {
      add(...names) {
        const tokens = new Set(node.className.split(/\s+/).filter(Boolean));
        names.forEach(name => tokens.add(name));
        node.className = [...tokens].join(' ');
      },
      remove(...names) {
        const blocked = new Set(names);
        node.className = node.className.split(/\s+/).filter(name => name && !blocked.has(name)).join(' ');
      },
      contains(name) {
        return node.className.split(/\s+/).includes(name);
      },
      toggle(name, force) {
        const present = this.contains(name);
        const next = force === undefined ? !present : Boolean(force);
        if (next) this.add(name);
        else this.remove(name);
        return next;
      },
    };
  }

  appendChild(child) {
    this._text = '';
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    return child;
  }

  replaceChildren(...children) {
    this._text = '';
    this.children = [...children];
  }

  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }

  getAttribute() {
    return null;
  }
}

function createEnvironment(responseBody) {
  const elements = new Map();
  const document = {
    createElement: tagName => new DomNode(tagName),
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new DomNode('div'));
      return elements.get(id);
    },
    querySelectorAll() {
      return [];
    },
  };
  const window = {};
  const fetch = async () => ({
    status: 200,
    json: async () => responseBody,
  });
  const context = {
    window,
    document,
    fetch,
    setInterval: () => 1,
    clearInterval: () => {},
    console,
  };
  window.window = window;

  const source = appSource.replace(
    '\nsetupAuthUi();\n',
    '\nwindow.__ph7 = { fetchPaperTrades: fetchPaperTrades, fetchLogs: fetchLogs, fetchInspector: fetchInspector };\n',
  );
  vm.runInNewContext(source, context, { filename: 'frontend/app.js' });
  return { document, renderers: window.__ph7 };
}

function findNodes(root, tagName, result = []) {
  if (root.tagName === tagName.toUpperCase()) result.push(root);
  root.children.forEach(child => findNodes(child, tagName, result));
  return result;
}

function assertNoMarkupNodes(root) {
  for (const tagName of ['img', 'script', 'svg']) {
    assert.equal(findNodes(root, tagName).length, 0, `unexpected ${tagName} node`);
  }
  const nodes = [];
  (function visit(node) {
    nodes.push(node);
    node.children.forEach(visit);
  }(root));
  for (const node of nodes) {
    for (const name of Object.keys(node.attributes)) {
      assert.notEqual(['onerror', 'onload', 'onclick'].includes(name.toLowerCase()), true, name);
    }
  }
}

function paperPayload(overrides = {}) {
  return {
    stats: { totalTrades: 1, openTrades: 1, closedTrades: 0, winRate: 0 },
    performance: {},
    open: [{
      direction: 'BUY',
      status: 'OPEN',
      entryTime: '2024-01-01T00:00:00.000Z',
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 110,
      pnl: null,
      ...overrides,
    }],
    closed: [],
  };
}

function closedPayload(overrides = {}) {
  return {
    stats: { totalTrades: 1, openTrades: 0, closedTrades: 1, winRate: 100 },
    performance: {},
    open: [],
    closed: [{
      direction: 'BUY',
      status: 'CLOSED',
      entryTime: '2024-01-01T00:00:00.000Z',
      entryPrice: 100,
      exitPrice: 110,
      confidence: 80,
      pnl: 10,
      ...overrides,
    }],
  };
}

test('source guard removes HTML parser sinks from app.js', () => {
  assert.doesNotMatch(appSource, /\.innerHTML\s*=/);
  assert.doesNotMatch(appSource, /insertAdjacentHTML/);
  assert.doesNotMatch(appSource, /\.outerHTML\s*=/);
  assert.doesNotMatch(appSource, /document\.write/);
  assert.doesNotMatch(appSource, /\.srcdoc\s*=/);
});

test('log messages remain literal text for the complete malicious corpus', async () => {
  for (const payload of PAYLOADS) {
    const environment = createEnvironment({
      logs: [{ level: 'INFO', timestamp: '2024-01-01T00:00:00.000Z', message: payload }],
    });
    await environment.renderers.fetchLogs();
    const logBody = environment.document.getElementById('logBody');
    assert.match(logBody.textContent, new RegExp(payload.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assertNoMarkupNodes(logBody);
  }
});

test('inspector gate details use text nodes', async () => {
  const payload = PAYLOADS[0];
  const environment = createEnvironment({
    available: true,
    price: 100,
    confluence: { bias: 'Neutral', score: 50 },
    thresholds: { bullish: 65, bearish: 35 },
    cycle: 1,
    gates: { confluenceBias: { pass: false, detail: payload } },
    verdict: { tradeOpened: false, rejectionReason: 'blocked' },
  });
  await environment.renderers.fetchInspector();
  const gates = environment.document.getElementById('inspGates');
  assert.match(gates.textContent, new RegExp(payload.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assertNoMarkupNodes(gates);
});

test('paper trade rows preserve runtime text without parsing it', async () => {
  const payload = PAYLOADS[2];
  const environment = createEnvironment(paperPayload({ direction: payload, status: payload }));
  await environment.renderers.fetchPaperTrades();
  const list = environment.document.getElementById('paperTrades');
  assert.match(list.textContent, new RegExp(payload.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assertNoMarkupNodes(list);
});

test('performance rows preserve runtime text without parsing it', async () => {
  const payload = PAYLOADS[1];
  const environment = createEnvironment(closedPayload({ direction: payload }));
  await environment.renderers.fetchPaperTrades();
  const list = environment.document.getElementById('perfSignals');
  assert.match(list.textContent, new RegExp(payload.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assertNoMarkupNodes(list);
});

test('empty paper and performance states preserve their visible text', async () => {
  const paperEnvironment = createEnvironment({
    stats: { totalTrades: 0, openTrades: 0, closedTrades: 0, winRate: 0 },
    performance: {},
    open: [],
    closed: [],
  });
  await paperEnvironment.renderers.fetchPaperTrades();
  const paperEmpty = paperEnvironment.document.getElementById('paperTrades');
  assert.equal(paperEmpty.children.length, 1);
  assert.equal(paperEmpty.children[0].className, 'paper-empty');
  assert.equal(paperEmpty.textContent, 'No trades yet');
  assertNoMarkupNodes(paperEmpty);

  const performanceEnvironment = createEnvironment({
    stats: { totalTrades: 1, openTrades: 1, closedTrades: 0, winRate: 0 },
    performance: {},
    open: [{ direction: 'BUY', status: 'OPEN', entryPrice: 100, stopLoss: 95, takeProfit: 110 }],
    closed: [],
  });
  await performanceEnvironment.renderers.fetchPaperTrades();
  const performanceEmpty = performanceEnvironment.document.getElementById('perfSignals');
  assert.equal(performanceEmpty.children.length, 1);
  assert.equal(performanceEmpty.children[0].className, 'perf-empty');
  assert.equal(performanceEmpty.textContent, 'No trade history');
  assertNoMarkupNodes(performanceEmpty);
});
