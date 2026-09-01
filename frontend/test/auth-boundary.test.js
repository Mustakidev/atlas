const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const frontendDir = path.join(__dirname, '..');
const appSource = fs.readFileSync(path.join(frontendDir, 'app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(frontendDir, 'index.html'), 'utf8');
const styleSource = fs.readFileSync(path.join(frontendDir, 'style.css'), 'utf8');

test('frontend has no master API-key bootstrap or header helper', () => {
  assert.equal(appSource.includes('window.__ATLAS_API_KEY'), false);
  assert.equal(appSource.includes('authHeaders'), false);
  assert.equal(appSource.includes('X-API-Key'), false);
  assert.equal(htmlSource.includes('window.__ATLAS_API_KEY'), false);
});

test('frontend has no JavaScript auth storage', () => {
  assert.equal(appSource.includes('localStorage'), false);
  assert.equal(appSource.includes('sessionStorage'), false);
  assert.equal(appSource.includes('Bearer '), false);
});

test('ordinary requests use same-origin credentials', () => {
  assert.match(appSource, /fetch\(url, \{ credentials: 'same-origin' \}\)/);
  assert.equal((appSource.match(/credentials: 'same-origin'/g) || []).length >= 4, true);
});

test('boot checks session before starting protected polling', () => {
  assert.match(appSource, /fetch\(API \+ '\/api\/auth\/session'/);
  assert.match(appSource, /function bootstrapAuth\(\)[\s\S]*startPolling\(\);/);
  assert.match(appSource, /setupAuthUi\(\);/);
});

test('login UI submits only the password to the session endpoint', () => {
  assert.match(htmlSource, /id="authForm"/);
  assert.match(htmlSource, /id="authPassword"[^>]*type="password"/);
  assert.match(appSource, /fetch\(API \+ '\/api\/auth\/login'/);
  assert.match(appSource, /JSON\.stringify\(\{ password: password \}\)/);
});

test('successful login starts polling and logout uses the session endpoint', () => {
  assert.match(appSource, /response\.status === 204[\s\S]*startPolling\(\);/);
  assert.match(appSource, /fetch\(API \+ '\/api\/auth\/logout'/);
  assert.match(htmlSource, /id="logoutBtn"/);
});

test('401 transitions to the login gate and stops polling', () => {
  assert.match(appSource, /function handleAuthenticationLoss\(/);
  assert.match(appSource, /function handleAuthenticationLoss\([\s\S]*stopPolling\(\);/);
  assert.match(appSource, /r\.status === 401[\s\S]*handleAuthenticationLoss/);
});

test('403 remains a security-policy error instead of session expiry', () => {
  assert.match(appSource, /response\.status === 403/);
  assert.match(appSource, /blocked by the browser origin policy/);
});

test('network errors remain separate from authentication loss', () => {
  assert.match(appSource, /Unable to reach the authentication service/);
  assert.match(appSource, /Unable to reach the replay service/);
  assert.equal(appSource.includes('catch (error) { handleAuthenticationLoss'), false);
});

test('replay uses same-origin cookies and preserves canonical request construction', () => {
  assert.match(appSource, /window\.AtlasReplayRequest\.buildUrl/);
  assert.match(appSource, /fetch\(replayUrl, \{ credentials: 'same-origin' \}\)/);
  assert.equal(appSource.includes('API_KEY'), false);
});

test('login gate styling is present without changing dashboard structure', () => {
  assert.match(htmlSource, /class="auth-gate"/);
  assert.match(htmlSource, /class="auth-card"/);
  assert.match(styleSource, /\.auth-gate/);
  assert.match(styleSource, /\.auth-card/);
});
