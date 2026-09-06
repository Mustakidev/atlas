const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const frontendDir = path.join(__dirname, '..');
const htmlPath = path.join(frontendDir, 'index.html');
const appPath = path.join(frontendDir, 'app.js');
const stylePath = path.join(frontendDir, 'style.css');
const vendorPath = path.join(frontendDir, 'vendor', 'lightweight-charts-4.1.3', 'dist', 'lightweight-charts.standalone.production.js');
const licensePath = path.join(frontendDir, 'vendor', 'lightweight-charts-4.1.3', 'LICENSE');
const expectedVendorSha384 = 'JZigAjwiaZtkUbA44CWkPaT3iBb/mU5pO6QOANp+OqHd4q+1+7MG1kzp2OOP9ZfP';

const htmlSource = fs.readFileSync(htmlPath, 'utf8');
const appSource = fs.readFileSync(appPath, 'utf8');
const styleSource = fs.readFileSync(stylePath, 'utf8');
const vendorRelativePath = 'vendor/lightweight-charts-4.1.3/dist/lightweight-charts.standalone.production.js';

test('HTML uses only local executable and stylesheet resources', () => {
  assert.doesNotMatch(htmlSource, /\bon[a-z]+\s*=/i);
  assert.doesNotMatch(htmlSource, /\bstyle\s*=/i);
  assert.doesNotMatch(htmlSource, /<script\b(?![^>]*\bsrc=)[^>]*>/i);
  assert.doesNotMatch(htmlSource, /<style\b/i);
  assert.doesNotMatch(htmlSource, /https?:\/\//i);
  assert.match(htmlSource, new RegExp(`<script src="${vendorRelativePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"></script>`));
  assert.match(htmlSource, /<link rel="stylesheet" href="style\.css">/);
  assert.match(htmlSource, /id="replayBtn"/);
  assert.doesNotMatch(htmlSource, /id="replayBtn"[^>]*onclick=/i);
});

test('frontend production sources retain the PH-7 and strict-source boundaries', () => {
  assert.doesNotMatch(appSource, /\.innerHTML\s*=/);
  assert.doesNotMatch(appSource, /insertAdjacentHTML/);
  assert.doesNotMatch(appSource, /\.outerHTML\s*=/);
  assert.doesNotMatch(appSource, /document\.write/);
  assert.doesNotMatch(appSource, /DOMParser/);
  assert.doesNotMatch(appSource, /\.srcdoc\s*=/);
  assert.doesNotMatch(appSource, /\beval\s*\(/);
  assert.doesNotMatch(appSource, /\bnew Function\b/);
  assert.doesNotMatch(`${htmlSource}\n${appSource}\n${styleSource}`, /https?:\/\//i);
  assert.match(appSource, /replayButton\.addEventListener\('click', window\.runReplay\)/);
  assert.equal(appSource.includes('setAttribute(\'style\''), false);
  assert.equal(appSource.includes('.style.cssText'), false);
});

test('vendored chart bytes and license are locked', () => {
  assert.equal(fs.existsSync(vendorPath), true);
  const vendorBytes = fs.readFileSync(vendorPath);
  assert.ok(vendorBytes.length > 0);
  assert.equal(crypto.createHash('sha384').update(vendorBytes).digest('base64'), expectedVendorSha384);
  assert.equal(fs.existsSync(licensePath), true);
  assert.ok(fs.statSync(licensePath).size > 0);
});
