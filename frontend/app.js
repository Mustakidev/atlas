/* Atlas Dashboard v2.0 — Trading Terminal */
(function() {
'use strict';

var API = '';
var REFRESH = 3000;
var CANDLE_REFRESH = 2000;
var chartCurrentTF = '1h';
var chartLastCandles = [];
var chartPrevFinalizedCount = 0;
var chartFirstLoad = true;
var chartInitialized = false;
var lastLogCount = 0;
var lastLogId = 0;
var currentPrice = null;
var pipelineDirection = null;
var authState = {
  authenticated: false,
  polling: false,
  pollingTimer: null,
  candleTimer: null,
};
var liveReadiness = 'STARTING';

// Request deduplication: track in-flight fetches to prevent duplicates
var inflight = {};
function showAuthGate(message) {
  var gate = $('authGate');
  var messageEl = $('authMessage');
  var logout = $('logoutBtn');
  if (messageEl && message) messageEl.textContent = message;
  if (gate) gate.classList.remove('hidden');
  if (logout) logout.classList.add('hidden');
}

function hideAuthGate() {
  var gate = $('authGate');
  var logout = $('logoutBtn');
  if (gate) gate.classList.add('hidden');
  if (logout) logout.classList.remove('hidden');
}

function stopPolling() {
  if (authState.pollingTimer !== null) {
    clearInterval(authState.pollingTimer);
    authState.pollingTimer = null;
  }
  if (authState.candleTimer !== null) {
    clearInterval(authState.candleTimer);
    authState.candleTimer = null;
  }
  authState.polling = false;
}

function handleAuthenticationLoss(message) {
  if (!authState.authenticated && $('authGate') && !$('authGate').classList.contains('hidden')) return;
  authState.authenticated = false;
  stopPolling();
  showAuthGate(message || 'Session expired. Sign in again.');
}

function dedupedFetch(key, url) {
  if (inflight[key]) return inflight[key];
  inflight[key] = fetch(url, { credentials: 'same-origin' })
    .then(function(r) {
      if (r.status === 401) {
        handleAuthenticationLoss('Session expired. Sign in again.');
        throw new Error('Authentication required');
      }
      return r;
    })
    .then(function(r) { return r.json(); })
    .then(function(d) { delete inflight[key]; return d; })
    .catch(function(e) { delete inflight[key]; throw e; });
  return inflight[key];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function $(id) { return document.getElementById(id); }

function fmtUSD(n) {
  if (n == null || isNaN(n)) return '--';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtK(n) {
  if (n == null || isNaN(n)) return '--';
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(2);
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return '--';
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

function fmtTime(ts) {
  if (!ts) return '--';
  var d = new Date(ts);
  return d.toLocaleTimeString();
}

function fmtShortTime(ts) {
  if (!ts) return '--';
  var d = new Date(ts);
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}

function setClass(el, cls) {
  if (!el) return;
  el.className = 'kv-val ' + cls;
}

function appendTextCell(parent, value, cls) {
  var cell = document.createElement('span');
  if (cls) cell.className = cls;
  cell.textContent = value;
  parent.appendChild(cell);
  return cell;
}

function renderEmptyState(container, className, text) {
  container.replaceChildren();
  var empty = document.createElement('div');
  empty.className = className;
  empty.textContent = text;
  container.appendChild(empty);
}

function trendClass(v) {
  if (!v) return '';
  v = String(v).toLowerCase();
  if (v === 'bullish') return 'bullish';
  if (v === 'bearish') return 'bearish';
  return 'sideways';
}

function volClass(v) {
  if (!v) return '';
  v = String(v).toLowerCase();
  if (v === 'high') return 'high';
  if (v === 'medium') return 'medium';
  return 'low';
}

function emaClass(v) {
  if (!v) return '';
  v = String(v).toLowerCase();
  if (v === 'above') return 'above';
  if (v === 'below') return 'below';
  return 'crossing';
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
function setConnected(ok) {
  var dot = $('statusDot');
  var txt = $('statusText');
  var ready = liveReadiness === 'READY';
  dot.className = 'status-dot ' + (ok && ready ? 'connected' : 'disconnected');
  txt.textContent = ready ? (ok ? 'Connected' : 'Disconnected') : readinessLabel(liveReadiness);
}

function readinessLabel(state) {
  if (state === 'UNINITIALIZED') return 'Live state not initialized';
  if (state === 'FAILED' || state === 'UNSAFE') return 'Live state unavailable';
  if (state === 'RESTORING') return 'Restoring live state';
  return 'Starting live state';
}

async function fetchReadiness() {
  try {
    var response = await fetch(API + '/readyz', { credentials: 'same-origin' });
    var data = await response.json();
    liveReadiness = data && typeof data.liveState === 'string'
      ? data.liveState
      : response.status === 200 ? 'READY' : 'FAILED';
  } catch (error) {
    liveReadiness = 'FAILED';
  }
  setConnected(liveReadiness === 'READY');
}

// ---------------------------------------------------------------------------
// Chart helpers
// ---------------------------------------------------------------------------
function fmtChVal(n) {
  if (n == null || isNaN(n)) return '--';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtChVol(n) {
  if (n == null || isNaN(n)) return '--';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(2);
}

function updateCrosshair(data) {
  if (!data || !data.candle) {
    ['chOpen','chHigh','chLow','chClose','chVol'].forEach(function(id){ $(id).textContent = '--'; });
    return;
  }
  var c = data.candle;
  $('chOpen').textContent = fmtChVal(c.open);
  $('chHigh').textContent = fmtChVal(c.high);
  $('chLow').textContent = fmtChVal(c.low);
  $('chClose').textContent = fmtChVal(c.close);
  $('chVol').textContent = data.volume ? fmtChVol(data.volume.value) : '--';
  var color = c.close >= c.open ? '#00e676' : '#ff5252';
  ['chOpen','chHigh','chLow','chClose'].forEach(function(id){ $(id).style.color = color; });
}

function setActiveTFButton(tf) {
  document.querySelectorAll('.tf-btn').forEach(function(btn) {
    btn.classList.toggle('active', btn.getAttribute('data-tf') === tf);
  });
}

function updateWaitingOverlay(count) {
  var el = $('chartWaiting');
  var countEl = $('chartWaitingCount');
  if (!el) return;
  if (count >= 20) { el.classList.add('hidden'); }
  else { el.classList.remove('hidden'); if (countEl) countEl.textContent = count + ' / 20 candles'; }
}

function initTimeframeSelector() {
  var sel = $('tfSelector');
  if (!sel) return;
  sel.addEventListener('click', function(e) {
    var btn = e.target.closest('.tf-btn');
    if (!btn) return;
    var tf = btn.getAttribute('data-tf');
    if (tf === chartCurrentTF) return;
    chartCurrentTF = tf;
    setActiveTFButton(tf);
    chartFirstLoad = true;
    chartLastCandles = [];
    chartPrevFinalizedCount = 0;
    var w = $('chartWaiting');
    if (w) w.classList.remove('hidden');
    fetchCandles();
  });
}

async function fetchCandles() {
  try {
    var data = await dedupedFetch('candles-' + chartCurrentTF, API + '/api/candles?timeframe=' + chartCurrentTF + '&limit=500');
    if (data.error) return;
    var all = (data.candles || []).slice();
    if (all.length === 0) return;
    updateWaitingOverlay(all.length);
    if (chartFirstLoad) {
      AtlasChart.setData(all);
      chartFirstLoad = false;
    } else {
      var lastTime = all[all.length - 1].openTime;
      var localTime = chartLastCandles.length > 0 ? chartLastCandles[chartLastCandles.length - 1].openTime : null;
      if (lastTime === localTime) { AtlasChart.updateCandle(all[all.length - 1]); }
      else { AtlasChart.setData(all); }
    }
    chartLastCandles = all;
    chartPrevFinalizedCount = (data.candles || []).length;
    $('ovCandles').textContent = all.length;
  } catch(e) {}
}

// ---------------------------------------------------------------------------
// Data Fetchers
// ---------------------------------------------------------------------------
async function fetchMarket() {
  try {
    var d = await dedupedFetch('market', API + '/api/market');
    if (!d || !d.connected) return;
    currentPrice = d.price;
    $('hdrPrice').textContent = fmtUSD(d.price);
    var chEl = $('hdrChange');
    chEl.textContent = fmtPct(d.change24h);
    chEl.className = 'header-change ' + (d.change24h >= 0 ? 'positive' : 'negative');
    $('ovVolume').textContent = fmtK(d.volume);
    $('ovChange').textContent = fmtPct(d.change24h);
    $('ovChange').className = 'ov-value ' + (d.change24h >= 0 ? 'positive' : 'negative');
    if (d.timestamp) $('ovUpdate').textContent = fmtTime(d.timestamp);
    setConnected(true);
  } catch(e) { setConnected(false); }
}

async function fetchAnalysis() {
  try {
    var d = await dedupedFetch('analysis', API + '/api/analysis');
    if (!d || !d.connected) return;
    // Trend
    if (d.trend) {
      setClass($('trend1H'), trendClass(d.trend['1H'])); $('trend1H').textContent = d.trend['1H'] || '--';
      setClass($('trend4H'), trendClass(d.trend['4H'])); $('trend4H').textContent = d.trend['4H'] || '--';
      setClass($('trend24H'), trendClass(d.trend['24H'])); $('trend24H').textContent = d.trend['24H'] || '--';
    }
    if (d.momentum) {
      $('trendMom').textContent = d.momentum['1H'] != null ? d.momentum['1H'] : '--';
    }
    if (d.confidence) {
      $('trendConf').textContent = d.confidence['1H'] != null ? d.confidence['1H'] + '%' : '--';
    }
    $('trendStatus').textContent = d.trend ? 'Live' : '--';
  } catch(e) {}
}

async function fetchStructure() {
  try {
    var d = await dedupedFetch('structure-' + chartCurrentTF, API + '/api/structure?timeframe=' + chartCurrentTF);
    if (!d) return;
    $('structureStatus').textContent = d.structure ? 'Live' : 'N/A';
    setClass($('structPattern'), trendClass(d.structure));
    $('structPattern').textContent = d.structure || '--';
    setClass($('structDir'), trendClass(d.direction));
    $('structDir').textContent = d.direction || '--';
    $('structBOS').textContent = d.lastBOS ? d.lastBOS.type + ' @ ' + fmtUSD(d.lastBOS.price) : 'None';
    setClass($('structScore'), d.score != null && d.score > 60 ? 'bullish' : d.score != null && d.score < 40 ? 'bearish' : '');
    $('structScore').textContent = d.score != null ? d.score : '--';
    $('structConf').textContent = d.confidence != null ? d.confidence + '%' : '--';
  } catch(e) {}
}

async function fetchIndicators() {
  try {
    // RSI — API returns { timeframe, candleCount, rsi: { ready, value, state, ... } }
    var rsiResp = await dedupedFetch('rsi-' + chartCurrentTF, API + '/api/indicators/rsi?timeframe=' + chartCurrentTF);
    var rsi = rsiResp && rsiResp.rsi ? rsiResp.rsi : null;
    if (rsi) {
      $('rsiStatus').textContent = rsi.ready ? 'Ready' : 'N/A';
      setClass($('rsiValue'), rsi.value > 70 ? 'bearish' : rsi.value < 30 ? 'bullish' : '');
      $('rsiValue').textContent = rsi.value != null ? rsi.value.toFixed(1) : '--';
      $('rsiState').textContent = rsi.state || '--';
      $('rsiInterp').textContent = rsi.signal || '--';
    }

    // EMA — API returns { symbol, timeframe, periods: { "9":{value,trend,ready}, "20":{...}, ... } }
    var emaResp = await dedupedFetch('ema-' + chartCurrentTF, API + '/api/indicators/ema?timeframe=' + chartCurrentTF);
    var emaPeriods = emaResp && emaResp.periods ? emaResp.periods : null;
    if (emaPeriods) {
      var ema20 = emaPeriods['20'] || {};
      $('emaStatus').textContent = ema20.ready ? 'Ready' : 'N/A';
      setClass($('emaTrend'), emaClass(ema20.trend));
      $('emaTrend').textContent = ema20.trend || '--';
      $('emaValue').textContent = ema20.value != null ? fmtUSD(ema20.value) : '--';
      var ema9 = emaPeriods['9'] || {};
      var interp = ema9.trend === 'Below' && ema20.trend === 'Above' ? 'Bullish crossover zone'
        : ema9.trend === 'Above' && ema20.trend === 'Below' ? 'Bearish crossover zone'
        : ema20.trend === 'Above' ? 'Price above EMA-20 (bullish)' : 'Price below EMA-20 (bearish)';
      $('emaInterp').textContent = interp;
    }

    // MACD
    var macd = await dedupedFetch('macd-' + chartCurrentTF, API + '/api/macd?timeframe=' + chartCurrentTF);
    if (macd && macd.ready !== undefined) {
      $('macdStatus').textContent = macd.ready ? 'Ready' : 'N/A';
      setClass($('macdTrend'), trendClass(macd.trend));
      $('macdTrend').textContent = macd.trend || '--';
      $('macdHist').textContent = macd.histogram != null ? macd.histogram.toFixed(4) : '--';
      $('macdSignal').textContent = macd.signal != null ? macd.signal.toFixed(6) : '--';
      $('macdInterp').textContent = macd.interpretation || (macd.crossover && macd.crossover !== 'None' ? 'Crossover: ' + macd.crossover : macd.trend || '--');
    }

    // ATR
    var atr = await dedupedFetch('atr-' + chartCurrentTF, API + '/api/atr?timeframe=' + chartCurrentTF);
    if (atr && atr.ready !== undefined) {
      $('atrStatus').textContent = atr.ready ? 'Ready' : 'N/A';
      $('atrValue').textContent = atr.atr != null ? atr.atr.toFixed(2) : '--';
      $('atrPct').textContent = atr.atrPercentage != null ? atr.atrPercentage.toFixed(2) + '%' : '--';
      setClass($('atrVol'), volClass(atr.volatilityLevel));
      $('atrVol').textContent = atr.volatilityLevel || '--';
      $('atrTrend').textContent = atr.volatilityTrend || '--';
    }

    // Bollinger — API returns { middleBand, upperBand, lowerBand, squeeze, pricePosition, lastClose, bandwidth, ... }
    var bb = await dedupedFetch('bollinger-' + chartCurrentTF, API + '/api/bollinger?timeframe=' + chartCurrentTF);
    if (bb && bb.ready !== undefined) {
      $('bollStatus').textContent = bb.ready ? 'Ready' : 'N/A';
      $('bollUpper').textContent = bb.upperBand != null ? fmtUSD(bb.upperBand) : '--';
      $('bollMid').textContent = bb.middleBand != null ? fmtUSD(bb.middleBand) : '--';
      $('bollLower').textContent = bb.lowerBand != null ? fmtUSD(bb.lowerBand) : '--';
      $('bollPos').textContent = bb.pricePosition || '--';
      var percentB = (bb.lastClose != null && bb.upperBand != null && bb.lowerBand != null && bb.upperBand !== bb.lowerBand)
        ? (bb.lastClose - bb.lowerBand) / (bb.upperBand - bb.lowerBand) : null;
      $('bollPB').textContent = percentB != null ? percentB.toFixed(3) : '--';
      setClass($('bollSqueeze'), bb.squeeze ? 'high' : '');
      $('bollSqueeze').textContent = bb.squeeze ? 'Active' : 'None';
    }
  } catch(e) {}
}

async function fetchMarketRegime() {
  try {
    var d = await dedupedFetch('market-regime-' + chartCurrentTF, API + '/api/market-regime?timeframe=' + chartCurrentTF);
    if (!d || !d.regime) return;
    $('regimeStatus').textContent = d.regime ? 'Live' : 'N/A';

    var regimeEl = $('regimeCurrent');
    regimeEl.textContent = d.regime || '--';
    regimeEl.className = 'regime-current-value ' + (d.regime === 'TRENDING_BULL' ? 'bullish' : d.regime === 'TRENDING_BEAR' ? 'bearish' : d.regime === 'RANGING' ? 'sideways' : d.regime === 'HIGH_VOLATILITY' ? 'high' : d.regime === 'LOW_VOLATILITY' ? 'low' : '');

    // Confidence gauge
    var conf = d.confidence != null ? d.confidence : 0;
    $('regimeConf').textContent = conf + '%';
    var confBar = $('regimeConfBar');
    confBar.style.width = conf + '%';
    confBar.style.background = conf > 60 ? '#00e676' : conf > 30 ? '#ffd740' : '#ff5252';

    // Trend score gauge
    var ts = d.trendScore != null ? d.trendScore : 0;
    $('regimeTrendScore').textContent = ts;
    var tsBar = $('regimeTrendBar');
    tsBar.style.width = ts + '%';
    tsBar.style.background = ts > 60 ? '#00e676' : ts > 40 ? '#ffd740' : '#ff5252';

    // Range score gauge
    var rs = d.rangeScore != null ? d.rangeScore : 0;
    $('regimeRangeScore').textContent = rs;
    var rsBar = $('regimeRangeBar');
    rsBar.style.width = rs + '%';
    rsBar.style.background = rs > 60 ? '#ffd740' : rs > 30 ? '#448aff' : '#4a5568';

    // Volatility
    $('regimeVol').textContent = d.volatility || '--';
    setClass($('regimeVol'), d.volatility === 'HIGH' ? 'high' : d.volatility === 'LOW' ? 'low' : '');
    $('regimeVolScore').textContent = d.volatilityScore != null ? d.volatilityScore : '--';

    // Reason
    $('regimeReason').textContent = d.decisionReason || '--';
  } catch(e) {}
}

async function fetchConfluence() {
  try {
    var d = await dedupedFetch('confluence-' + chartCurrentTF, API + '/api/confluence?timeframe=' + chartCurrentTF);
    if (!d) return;
    $('confStatus').textContent = d.score != null ? 'Live' : 'N/A';
    $('confScore').textContent = d.score != null ? d.score : '--';
    setClass($('confBias'), trendClass(d.bias));
    $('confBias').textContent = d.bias || '--';
    $('confConf').textContent = d.confidence != null ? d.confidence + '%' : '--';
    var compCount = d.components ? Object.keys(d.components).length : 0;
    $('confComps').textContent = compCount;
    $('confMissing').textContent = d.missing ? d.missing.length : 0;
    // Update ring
    var ring = $('confRing');
    if (ring && d.score != null) {
      var circumference = 326.73;
      var offset = circumference - (d.score / 100) * circumference;
      ring.style.strokeDashoffset = offset;
      ring.style.stroke = d.bias === 'Bullish' ? '#00e676' : d.bias === 'Bearish' ? '#ff5252' : '#ffd740';
    }
    // Overview strip
    $('ovConfluence').textContent = (d.score != null ? d.score + ' ' : '--') + (d.bias || '');
    setClass($('ovConfluence'), trendClass(d.bias));
  } catch(e) {}
}

async function updatePipelineDirection() {
  try {
    var pt = await dedupedFetch('paper-trades-dir', API + '/api/paper-trades');
    if (pt && pt.open && pt.open.length > 0 && pt.open[0].direction) {
      pipelineDirection = pt.open[0].direction;
      return;
    }

    var d = await dedupedFetch('pipeline-direction', API + '/api/signal/inspector');
    if (!d || !d.available) { pipelineDirection = null; return; }
    var dir = null;
    if (d.verdict && d.verdict.trade) {
      var vd = d.verdict.trade.direction;
      if (vd === 'BUY' || vd === 'SELL') dir = vd;
    }
    if (!dir && d.regimeDecision) {
      var rd = d.regimeDecision.preferredDirection;
      if (rd === 'BUY' || rd === 'SELL') dir = rd;
    }
    if (!dir && d.risk && d.risk.direction) {
      var rkd = d.risk.direction;
      if (rkd === 'BUY' || rkd === 'SELL') dir = rkd;
    }
    pipelineDirection = dir;
  } catch(e) {
    pipelineDirection = null;
  }
}

async function fetchAdvanceRisk() {
  try {
    var price = currentPrice;
    var dir = pipelineDirection;
    if (!price || !dir) return;
    var d = await dedupedFetch('advance-risk-' + chartCurrentTF + '-' + dir, API + '/api/advance-risk?timeframe=' + chartCurrentTF + '&entryPrice=' + price + '&direction=' + dir);
    if (!d) return;
    $('advanceRiskStatus').textContent = d.tradeAllowed ? 'Allowed' : 'Rejected';
    $('advPosSize').textContent = d.positionSize != null ? d.positionSize : '--';
    $('advDollarRisk').textContent = d.dollarRisk != null ? fmtUSD(d.dollarRisk) : '--';
    $('advSL').textContent = d.stopLoss != null ? fmtUSD(d.stopLoss) : '--';
    setClass($('advSL'), 'bearish');
    $('advTP').textContent = d.takeProfit != null ? fmtUSD(d.takeProfit) : '--';
    setClass($('advTP'), 'bullish');
    $('advRR').textContent = d.riskReward != null ? '1:' + d.riskReward : '--';
    $('advSession').textContent = d.session || '--';
    $('advDailyLoss').textContent = d.dailyPnL != null ? fmtUSD(d.dailyPnL) : '--';
    $('advConsecLoss').textContent = d.consecutiveLosses != null ? d.consecutiveLosses : '--';
    var verdict = $('advRiskVerdict');
    var icon = $('advRiskVerdictIcon');
    var text = $('advRiskVerdictText');
    var rej = $('advRiskRejection');
    if (d.tradeAllowed) {
      verdict.className = 'risk-verdict allowed';
      icon.textContent = '\u2713';
      icon.style.color = '#00e676';
      text.textContent = 'TRADE ALLOWED';
      text.style.color = '#00e676';
      rej.textContent = '';
    } else {
      verdict.className = 'risk-verdict rejected';
      icon.textContent = '\u2717';
      icon.style.color = '#ff5252';
      text.textContent = 'TRADE REJECTED';
      text.style.color = '#ff5252';
      rej.textContent = d.rejectionReason || '';
    }
  } catch(e) {}
}

async function fetchMtfConfirmation() {
  try {
    var price = currentPrice;
    var dir = pipelineDirection;
    if (!price || !dir) return;
    var d = await dedupedFetch('mtf-confirmation-' + dir, API + '/api/mtf-confirmation?direction=' + dir + '&timeframe=' + chartCurrentTF);
    if (!d) return;
    $('mtfConfStatus').textContent = d.mtfAllowed ? 'Allowed' : 'Rejected';
    var alignment = d.alignment || {};
    $('mtf1m').textContent = alignment['1m'] || '--';
    setClass($('mtf1m'), (alignment['1m'] || '').toLowerCase() === 'bullish' ? 'bullish' : (alignment['1m'] || '').toLowerCase() === 'bearish' ? 'bearish' : '');
    $('mtf5m').textContent = alignment['5m'] || '--';
    setClass($('mtf5m'), (alignment['5m'] || '').toLowerCase() === 'bullish' ? 'bullish' : (alignment['5m'] || '').toLowerCase() === 'bearish' ? 'bearish' : '');
    $('mtf15m').textContent = alignment['15m'] || '--';
    setClass($('mtf15m'), (alignment['15m'] || '').toLowerCase() === 'bullish' ? 'bullish' : (alignment['15m'] || '').toLowerCase() === 'bearish' ? 'bearish' : '');
    $('mtf1h').textContent = alignment['1h'] || '--';
    setClass($('mtf1h'), (alignment['1h'] || '').toLowerCase() === 'bullish' ? 'bullish' : (alignment['1h'] || '').toLowerCase() === 'bearish' ? 'bearish' : '');
    $('mtfAlignment').textContent = d.alignmentScore != null ? d.alignmentScore + '%' : '--';
    $('mtfConfidence').textContent = d.confidence != null ? d.confidence + '%' : '--';
    var verdict = $('mtfVerdict');
    var icon = $('mtfVerdictIcon');
    var text = $('mtfVerdictText');
    var rej = $('mtfRejection');
    if (d.mtfAllowed) {
      verdict.className = 'risk-verdict allowed';
      icon.textContent = '\u2713';
      icon.style.color = '#00e676';
      text.textContent = 'MTF CONFIRMED';
      text.style.color = '#00e676';
      rej.textContent = '';
    } else {
      verdict.className = 'risk-verdict rejected';
      icon.textContent = '\u2717';
      icon.style.color = '#ff5252';
      text.textContent = 'MTF BLOCKED';
      text.style.color = '#ff5252';
      rej.textContent = d.rejectionReason || '';
    }
  } catch(e) {}
}

async function fetchPaperTrades() {
  try {
    var d = await dedupedFetch('paper-trades', API + '/api/paper-trades');
    if (!d) return;
    var stats = d.stats || {};
    var perf = d.performance || {};
    var openTrades = d.open || [];
    var closedTrades = d.closed || [];

    $('paperTotal').textContent = stats.totalTrades || 0;
    $('paperOpen').textContent = stats.openTrades || 0;
    $('paperWins').textContent = (stats.closedTrades || 0) - (stats.lossRate > 0 ? Math.round(stats.closedTrades * stats.lossRate / 100) : 0);
    var wins = stats.winRate > 0 && stats.closedTrades > 0 ? Math.round(stats.closedTrades * stats.winRate / 100) : 0;
    var losses = stats.closedTrades - wins;
    $('paperWins').textContent = wins;
    $('paperWins').className = 'paper-stat-val ' + (wins > losses ? 'bullish' : '');
    $('paperLosses').textContent = losses;
    $('paperLosses').className = 'paper-stat-val ' + (losses > wins ? 'bearish' : '');
    $('paperWinRate').textContent = stats.winRate != null ? stats.winRate + '%' : '0%';
    $('paperBalance').textContent = stats.balance != null ? fmtUSD(stats.balance) : '$10,000';
    var pnl = stats.totalPnl || 0;
    $('paperPnl').textContent = (pnl >= 0 ? '+$' : '-$') + Math.abs(pnl).toFixed(2);
    setClass($('paperPnl'), pnl >= 0 ? 'pnl-pos' : 'pnl-neg');
    $('paperStatus').textContent = openTrades.length + ' open | ' + closedTrades.length + ' closed';

    // Render open + closed trades
    var allTrades = openTrades.concat(closedTrades.slice(-20).reverse());
    var list = $('paperTrades');
    if (allTrades.length === 0) {
      renderEmptyState(list, 'paper-empty', 'No trades yet');
      return;
    }
    list.replaceChildren();
    for (var i = 0; i < allTrades.length; i++) {
      var t = allTrades[i];
      var dirCls = t.direction === 'BUY' ? 'dir-buy' : 'dir-sell';
      var stCls = t.status === 'OPEN' || t.status === 'ACTIVE' ? 'status-open' : 'status-closed';
      var pnlVal = t.pnl != null ? t.pnl : '--';
      var pnlText = t.pnl != null ? (t.pnl >= 0 ? '+$' : '-$') + Math.abs(t.pnl).toFixed(2) : '--';
      var pnlCls = t.pnl == null ? '' : t.pnl >= 0 ? 'pnl-pos' : 'pnl-neg';
      var reason = t.exitReason || t.status || '';
      var row = document.createElement('div');
      row.className = 'paper-row';
      appendTextCell(row, fmtShortTime(t.entryTime || t.timestamp));
      appendTextCell(row, t.direction, dirCls);
      appendTextCell(row, fmtUSD(t.entryPrice));
      appendTextCell(row, fmtUSD(t.stopLoss));
      appendTextCell(row, fmtUSD(t.takeProfit));
      appendTextCell(row, t.status || '--', stCls);
      appendTextCell(row, pnlText, pnlCls);
      list.appendChild(row);
    }

    // Update performance panel
    $('perfWinRate').textContent = stats.winRate != null ? stats.winRate + '%' : '0%';
    setClass($('perfWinRate'), stats.winRate > 50 ? 'bullish' : '');
    $('perfProfitFactor').textContent = perf.profitFactor != null ? perf.profitFactor : '0';
    setClass($('perfProfitFactor'), perf.profitFactor > 1 ? 'bullish' : perf.profitFactor < 1 && perf.profitFactor > 0 ? 'bearish' : '');
    $('perfExpectancy').textContent = perf.expectancy != null ? '$' + perf.expectancy.toFixed(2) : '$0';
    $('perfDrawdown').textContent = perf.maxDrawdownPct != null ? perf.maxDrawdownPct + '%' : '0%';
    setClass($('perfDrawdown'), perf.maxDrawdownPct > 5 ? 'bearish' : '');
    $('perfReturn').textContent = perf.netReturnPct != null ? fmtPct(perf.netReturnPct) : '0%';
    setClass($('perfReturn'), perf.netReturnPct > 0 ? 'bullish' : perf.netReturnPct < 0 ? 'bearish' : '');
    $('perfStreak').textContent = (perf.currentStreak || 0) + ' ' + (perf.currentStreakType || 'None');
    setClass($('perfStreak'), perf.currentStreakType === 'Win' ? 'bullish' : perf.currentStreakType === 'Loss' ? 'bearish' : '');

    // Render closed trades in performance history
    var histList = $('perfSignals');
    if (closedTrades.length === 0) {
      renderEmptyState(histList, 'perf-empty', 'No trade history');
      return;
    }
    histList.replaceChildren();
    var shown = closedTrades.slice(-20).reverse();
    for (var j = 0; j < shown.length; j++) {
      var ct = shown[j];
      var biasCls = ct.direction === 'BUY' ? 'dir-buy' : 'dir-sell';
      var outCls = ct.pnl > 0 ? 'outcome-correct' : ct.pnl < 0 ? 'outcome-incorrect' : 'outcome-neutral';
      var outcomeText = ct.pnl > 0 ? 'WIN' : ct.pnl < 0 ? 'LOSS' : 'BREAKEVEN';
      var historyRow = document.createElement('div');
      historyRow.className = 'perf-row';
      appendTextCell(historyRow, fmtShortTime(ct.entryTime));
      appendTextCell(historyRow, ct.direction, biasCls);
      appendTextCell(historyRow, ct.confidence || '--');
      appendTextCell(historyRow, fmtUSD(ct.entryPrice));
      appendTextCell(historyRow, fmtUSD(ct.exitPrice));
      appendTextCell(historyRow, outcomeText, outCls);
      histList.appendChild(historyRow);
    }
    $('perfStatus').textContent = closedTrades.length + ' trades';
  } catch(e) {}
}

async function fetchLogs() {
  try {
    var d = await dedupedFetch('logs', API + '/api/logs?limit=100');
    if (!d || !d.logs) return;
    var logs = d.logs;
    var body = $('logBody');
    for (var i = lastLogCount; i < logs.length; i++) {
      var entry = logs[i];
      var div = document.createElement('div');
      var level = (entry.level || 'info').toLowerCase();
      var levelClass = {
        info: 'log-info',
        error: 'log-error',
        warning: 'log-warning',
        success: 'log-success',
        system: 'log-system',
      }[level] || 'log-info';
      div.className = 'log-entry ' + levelClass;
      var time = fmtTime(entry.timestamp);
      var meta = entry.meta && Object.keys(entry.meta).length ? ' ' + JSON.stringify(entry.meta) : '';
      appendTextCell(div, '[' + time + ']', 'log-time');
      appendTextCell(div, '[' + (entry.level || 'INFO').toUpperCase() + '] ' + entry.message + meta);
      body.appendChild(div);
    }
    if (body.children.length > 100) {
      while (body.children.length > 100) body.removeChild(body.firstChild);
    }
    body.scrollTop = body.scrollHeight;
    $('logCount').textContent = body.children.length;
    lastLogCount = logs.length;
  } catch(e) {}
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
function initChart() {
  var container = $('chartContainer');
  if (!container || typeof AtlasChart === 'undefined') return;
  if (!chartInitialized) {
    AtlasChart.init(container);
    AtlasChart.onCrosshairMove(function(data) { updateCrosshair(data); });
    initTimeframeSelector();
    chartInitialized = true;
  }
  updateWaitingOverlay(0);
  fetchCandles();
  if (authState.candleTimer === null) authState.candleTimer = setInterval(fetchCandles, CANDLE_REFRESH);
}

function startPolling() {
  if (authState.polling) return;
  authState.authenticated = true;
  authState.polling = true;
  fetchReadiness();
  fetchMarket();
  fetchAnalysis();
  fetchStructure();
  fetchIndicators();
  fetchConfluence();
  fetchMarketRegime();
  fetchAdvanceRisk();
  fetchMtfConfirmation();
  fetchPaperTrades();
  fetchInspector();
  fetchLogs();
  updatePipelineDirection();

  authState.pollingTimer = setInterval(function() {
    fetchReadiness();
    fetchMarket();
    fetchAnalysis();
    fetchStructure();
    fetchIndicators();
    fetchConfluence();
    fetchMarketRegime();
    fetchAdvanceRisk();
    fetchMtfConfirmation();
    fetchPaperTrades();
    fetchInspector();
    fetchLogs();
    updatePipelineDirection();
  }, REFRESH);

  initChart();
}

function setAuthMessage(message) {
  var messageEl = $('authMessage');
  if (messageEl) messageEl.textContent = message;
}

async function submitLogin(event) {
  event.preventDefault();
  var input = $('authPassword');
  var password = input ? input.value : '';
  if (input) input.value = '';
  if (!password) {
    setAuthMessage('Enter the operator password.');
    return;
  }

  var submit = $('authSubmit');
  if (submit) submit.disabled = true;
  setAuthMessage('Signing in...');
  try {
    var response = await fetch(API + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ password: password }),
    });
    if (response.status === 204) {
      hideAuthGate();
      startPolling();
      return;
    }
    if (response.status === 429) setAuthMessage('Too many attempts. Try again later.');
    else if (response.status === 403) setAuthMessage('Sign-in is blocked by the browser origin policy.');
    else setAuthMessage('Authentication failed.');
  } catch (error) {
    setAuthMessage('Unable to reach the authentication service.');
  } finally {
    if (submit) submit.disabled = false;
  }
}

async function logout() {
  var button = $('logoutBtn');
  if (button) button.disabled = true;
  try {
    var response = await fetch(API + '/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
    });
    if (response.status === 204) {
      handleAuthenticationLoss('Signed out.');
    } else if (response.status === 403) {
      setAuthMessage('Sign-out was blocked by the browser origin policy.');
    }
  } catch (error) {
    setAuthMessage('Unable to reach the authentication service.');
  } finally {
    if (button) button.disabled = false;
  }
}

async function bootstrapAuth() {
  showAuthGate('Checking session...');
  try {
    var response = await fetch(API + '/api/auth/session', { credentials: 'same-origin' });
    if (response.status !== 200) {
      showAuthGate('Unable to check the current session.');
      return;
    }
    var data = await response.json();
    if (data && data.authenticated === true) {
      hideAuthGate();
      startPolling();
    } else {
      showAuthGate('Sign in to continue.');
    }
  } catch (error) {
    showAuthGate('Unable to check the current session.');
  }
}

function setupAuthUi() {
  var form = $('authForm');
  var logoutButton = $('logoutBtn');
  if (form) form.addEventListener('submit', submitLogin);
  if (logoutButton) logoutButton.addEventListener('click', logout);
  fetchReadiness();
  bootstrapAuth();
}

setupAuthUi();

// ---------------------------------------------------------------------------
// Signal Inspector
// ---------------------------------------------------------------------------
async function fetchInspector() {
  try {
    var d = await dedupedFetch('inspector', API + '/api/signal/inspector');
    if (!d || !d.available) return;

    $('inspPrice').textContent = d.price ? fmtUSD(d.price) : '--';
    var biasEl = $('inspBias');
    biasEl.textContent = d.confluence ? d.confluence.bias : '--';
    biasEl.className = 'inspector-snap-val ' + (d.confluence ? (d.confluence.bias === 'Bullish' ? 'bullish' : d.confluence.bias === 'Bearish' ? 'bearish' : '') : '');
    $('inspScore').textContent = d.confluence ? d.confluence.score : '--';
    $('inspBuyThresh').textContent = d.thresholds ? d.thresholds.bullish : '--';
    $('inspSellThresh').textContent = d.thresholds ? d.thresholds.bearish : '--';
    $('inspCycle').textContent = '#' + (d.cycle || 0);

    // Market Regime in Inspector
    if (d.marketRegime) {
      var mr = d.marketRegime;
      $('inspRegime').textContent = mr.regime || '--';
      $('inspRegime').className = 'inspector-snap-val ' + (mr.regime === 'TRENDING_BULL' ? 'bullish' : mr.regime === 'TRENDING_BEAR' ? 'bearish' : mr.regime === 'RANGING' ? 'sideways' : mr.regime === 'HIGH_VOLATILITY' ? 'high' : '');
      $('inspRegimeConf').textContent = mr.confidence != null ? mr.confidence + '%' : '--';
      $('inspRegimeTrend').textContent = mr.trendScore != null ? mr.trendScore : '--';
      $('inspRegimeRange').textContent = mr.rangeScore != null ? mr.rangeScore : '--';
      $('inspRegimeVol').textContent = mr.volatility || '--';
    }

    // Regime Decision in Inspector
    if (d.regimeDecision) {
      var rd = d.regimeDecision;
      $('inspRegimeDecisionStatus').textContent = rd.allowTrade ? 'ALLOWED' : 'BLOCKED';
      $('inspRegimeDecisionStatus').className = 'inspector-snap-val ' + (rd.allowTrade ? 'bullish' : 'bearish');
      $('inspRegimeDecisionPref').textContent = rd.preferredDirection || '--';
      $('inspRegimeDecisionPenalty').textContent = rd.penalty != null ? '-' + rd.penalty + '%' : '--';
      $('inspRegimeDecisionReason').textContent = rd.reason || '--';
    }

    var gateNames = ['confluenceBias', 'regimeDecision', 'mtfConfirmation', 'trend', 'structure', 'rsi', 'ema', 'macd', 'atr', 'bollinger', 'advanceRisk'];
    var gateLabels = { confluenceBias: 'Confluence Bias', regimeDecision: 'Regime Decision', mtfConfirmation: 'MTF Confirmation', trend: 'Trend', structure: 'Structure', rsi: 'RSI', ema: 'EMA', macd: 'MACD', atr: 'ATR', bollinger: 'Bollinger', advanceRisk: 'Advance Risk' };
    var gatesEl = $('inspGates');
    gatesEl.replaceChildren();
    for (var i = 0; i < gateNames.length; i++) {
      var gk = gateNames[i];
      var g = d.gates && d.gates[gk];
      var statusCls, statusText, detail;
      if (g) {
        statusCls = g.pass ? 'gate-pass' : 'gate-fail';
        statusText = g.pass ? 'PASS' : 'FAIL';
        detail = g.detail || '--';
      } else {
        statusCls = 'gate-na';
        statusText = '--';
        detail = 'Not evaluated';
      }
      var gateRow = document.createElement('div');
      gateRow.className = 'inspector-gate-row';
      appendTextCell(gateRow, gateLabels[gk]);
      appendTextCell(gateRow, statusText, statusCls);
      appendTextCell(gateRow, detail);
      gatesEl.appendChild(gateRow);
    }

    var v = d.verdict;
    var vIcon = $('inspVerdictIcon');
    var vText = $('inspVerdictText');
    var vDetail = $('inspVerdictDetail');

    // Add market regime context to rejection reason
    var regimeContext = '';
    if (d.marketRegime && !v.tradeOpened) {
      var mr = d.marketRegime;
      if (mr.regime === 'RANGING') {
        regimeContext = 'Market is ranging. Trend confidence only ' + (mr.trendScore != null ? mr.trendScore : '--') + '%.';
      } else if (mr.regime === 'HIGH_VOLATILITY') {
        regimeContext = 'High volatility regime. Risk controls may block trades.';
      }
    }

    if (v.tradeOpened) {
      vIcon.textContent = 'TRADE OPENED';
      vIcon.className = 'inspector-verdict-icon v-pass';
      vText.textContent = v.trade ? v.trade.direction + ' @ ' + fmtUSD(v.trade.entryPrice) : 'YES';
      vText.className = 'inspector-verdict-text';
    } else {
      vIcon.textContent = 'REJECTED';
      vIcon.className = 'inspector-verdict-icon v-fail';
      var rejectionMsg = v.rejectionReason || 'Unknown';
      if (regimeContext) rejectionMsg = regimeContext + ' ' + rejectionMsg;
      vText.textContent = rejectionMsg;
      vText.className = 'inspector-verdict-text';
    }
    vDetail.textContent = '';

    var tradeEl = $('inspTrade');
    if (v.tradeOpened && v.trade) {
      tradeEl.classList.remove('hidden');
      $('inspEntry').textContent = fmtUSD(v.trade.entryPrice);
      $('inspSL').textContent = fmtUSD(v.trade.stopLoss);
      $('inspTP').textContent = fmtUSD(v.trade.takeProfit);
      $('inspPosSize').textContent = v.trade.positionSize;
      $('inspRR').textContent = '1:' + v.trade.riskReward;
    } else {
      tradeEl.classList.add('hidden');
    }

    $('inspectorStatus').textContent = 'Cycle #' + (d.cycle || 0);
  } catch(e) {}
}

// ---------------------------------------------------------------------------
// Strategy Replay
// ---------------------------------------------------------------------------
function replayIsFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function replayText(value) {
  if (value === null || value === undefined || value === '') return '--';
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return '--';
  return String(value);
}

function replayMetricClass(base, cls) {
  return base + (cls ? ' ' + cls : '');
}

function setReplayMetric(id, text, cls) {
  var el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className = replayMetricClass('replay-stat-val', cls);
}

function replayPercent(value) {
  return replayIsFiniteNumber(value) ? value + '%' : '--';
}

function replayMoney(value) {
  if (!replayIsFiniteNumber(value)) return '--';
  return (value >= 0 ? '+$' : '-$') + Math.abs(value).toFixed(2);
}

function replayPrice(value) {
  return replayIsFiniteNumber(value) ? fmtUSD(value) : '--';
}

function replayDirectionStats(value) {
  if (!value || !replayIsFiniteNumber(value.wins) || !replayIsFiniteNumber(value.losses)) return '--';
  return value.wins + '/' + value.losses;
}

function replayDirectionClass(direction) {
  if (direction === 'BUY') return 'dir-buy';
  if (direction === 'SELL') return 'dir-sell';
  return '';
}

function replayOutcomeClass(outcome) {
  if (outcome === 'PROFIT') return 'outcome-profit';
  if (outcome === 'LOSS') return 'outcome-loss';
  if (outcome === 'BREAKEVEN') return 'outcome-breakeven';
  if (outcome === 'OPEN') return 'outcome-open';
  if (outcome === 'PENDING') return 'outcome-pending';
  if (outcome === 'CLOSED') return 'outcome-closed';
  return '';
}

function replayOutcomeText(trade) {
  var text = replayText(trade.outcome);
  var reason = replayText(trade.exitReason);
  return reason === '--' ? text : text + ' · ' + reason;
}

function appendReplayCell(row, value, cls) {
  var cell = document.createElement('span');
  if (cls) cell.className = cls;
  cell.textContent = replayText(value);
  row.appendChild(cell);
  return cell;
}

function renderReplayMessage(message) {
  var list = $('replayTradesList');
  if (!list) return;
  list.textContent = '';
  var messageEl = document.createElement('div');
  messageEl.className = 'replay-empty';
  messageEl.textContent = message;
  list.appendChild(messageEl);
}

function resetReplayView(message) {
  setReplayMetric('replayTrades', '--', '');
  setReplayMetric('replayWinRate', '--', '');
  setReplayMetric('replayPF', '--', '');
  setReplayMetric('replayExpectancy', '--', '');
  setReplayMetric('replayDD', '--', '');
  setReplayMetric('replayPnl', '--', '');
  setReplayMetric('replayLongs', '--', '');
  setReplayMetric('replayShorts', '--', '');
  $('replayStatus').textContent = message || '--';
  renderReplayMessage('Click "Run 30D" to start replay');
}

function finishReplay(btn) {
  if (!btn) return;
  btn.disabled = false;
  btn.textContent = 'Run 30D';
  btn.className = 'replay-btn';
}

function replayStatusMessage(status) {
  if (status === 400) return 'Replay request is invalid. Check the replay configuration.';
  if (status === 401) return 'Authentication required. Sign in again.';
  if (status === 429) return 'Replay is rate-limited. Try again shortly.';
  if (status === 502) return 'Replay data source is temporarily unavailable.';
  if (status === 503) return 'Replay service is temporarily unavailable.';
  if (status === 500) return 'Replay failed on the server. Try again later.';
  return 'Replay request failed.';
}

function renderReplayModel(model) {
  var summary = model.summary;
  var directions = model.directions;
  var winRateClass = replayIsFiniteNumber(summary.winRate)
    ? summary.winRate > 50 ? 'bullish' : summary.winRate < 40 ? 'bearish' : '' : '';
  var profitFactorClass = replayIsFiniteNumber(summary.profitFactor)
    ? summary.profitFactor > 1 ? 'bullish' : summary.profitFactor > 0 ? 'bearish' : '' : '';
  var expectancyClass = replayIsFiniteNumber(summary.expectancy)
    ? summary.expectancy > 0 ? 'bullish' : 'bearish' : '';
  var drawdownClass = replayIsFiniteNumber(summary.maxDrawdownPct) && summary.maxDrawdownPct > 5 ? 'bearish' : '';
  var pnlClass = replayIsFiniteNumber(summary.totalPnl)
    ? summary.totalPnl >= 0 ? 'pnl-pos' : 'pnl-neg' : '';
  var buyClass = directions.BUY && replayIsFiniteNumber(directions.BUY.winRate) && directions.BUY.winRate > 50 ? 'bullish' : '';
  var sellClass = directions.SELL && replayIsFiniteNumber(directions.SELL.winRate) && directions.SELL.winRate > 50 ? 'bullish' : '';

  setReplayMetric('replayTrades', replayIsFiniteNumber(summary.totalTrades) ? String(summary.totalTrades) : '--', '');
  setReplayMetric('replayWinRate', replayPercent(summary.winRate), winRateClass);
  setReplayMetric('replayPF', summary.profitFactor === 'Infinity'
    || replayIsFiniteNumber(summary.profitFactor) ? String(summary.profitFactor) : '--', profitFactorClass);
  setReplayMetric('replayExpectancy', replayIsFiniteNumber(summary.expectancy) ? '$' + summary.expectancy.toFixed(2) : '--', expectancyClass);
  setReplayMetric('replayDD', replayPercent(summary.maxDrawdownPct), drawdownClass);
  setReplayMetric('replayPnl', replayMoney(summary.totalPnl), pnlClass);
  setReplayMetric('replayLongs', replayDirectionStats(directions.BUY), buyClass);
  setReplayMetric('replayShorts', replayDirectionStats(directions.SELL), sellClass);

  var cycleText;
  if (model.completion.status && model.completion.status !== 'EXHAUSTED') {
    cycleText = 'Replay status: ' + replayText(model.completion.status);
  } else if (replayIsFiniteNumber(model.completion.cyclesProcessed)) {
    cycleText = 'Completed · ' + model.completion.cyclesProcessed + ' cycles processed';
  } else {
    cycleText = 'Replay complete';
  }
  $('replayStatus').textContent = cycleText;

  var list = $('replayTradesList');
  list.textContent = '';
  if (model.trades.length === 0) {
    renderReplayMessage('No trades generated for this replay window');
    return;
  }

  model.trades.forEach(function(trade) {
    var row = document.createElement('div');
    row.className = 'replay-row';
    appendReplayCell(row, trade.tradeId);
    appendReplayCell(row, trade.direction, replayDirectionClass(trade.direction));
    appendReplayCell(row, replayPrice(trade.entry));
    appendReplayCell(row, replayPrice(trade.exit));
    appendReplayCell(row, replayPrice(trade.stopLoss));
    appendReplayCell(row, replayPrice(trade.takeProfit));
    appendReplayCell(row, trade.durationText);
    appendReplayCell(row, replayOutcomeText(trade), replayOutcomeClass(trade.outcome));
    list.appendChild(row);
  });
}

window.runReplay = async function() {
  var btn = $('replayBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Running...'; btn.className = 'replay-btn loading'; }
  resetReplayView('Running canonical replay...');
  renderReplayMessage('Running canonical replay...');

  if (!window.AtlasReplayRequest || typeof window.AtlasReplayRequest.buildUrl !== 'function'
    || !window.AtlasReplayPresentation
    || typeof window.AtlasReplayPresentation.presentCanonicalReplay !== 'function') {
    resetReplayView('Replay could not be displayed.');
    renderReplayMessage('Replay could not be displayed.');
    finishReplay(btn);
    return;
  }

  var replayUrl;
  try {
    var nowMs = Date.now();
    replayUrl = window.AtlasReplayRequest.buildUrl(API, nowMs);
  } catch (error) {
    resetReplayView('Replay could not be displayed.');
    renderReplayMessage('Replay could not be displayed.');
    finishReplay(btn);
    return;
  }

  var response;
  try {
    response = await fetch(replayUrl, { credentials: 'same-origin' });
  } catch (error) {
    resetReplayView('Unable to reach the replay service. Check your connection.');
    renderReplayMessage('Unable to reach the replay service. Check your connection.');
    finishReplay(btn);
    return;
  }

  if (!response || typeof response.status !== 'number') {
    resetReplayView('Replay returned an invalid response.');
    renderReplayMessage('Replay returned an invalid response.');
    finishReplay(btn);
    return;
  }

  if (response.status === 401) {
    handleAuthenticationLoss('Session expired. Sign in again.');
    resetReplayView('Session expired. Sign in again.');
    renderReplayMessage('Session expired. Sign in again.');
    finishReplay(btn);
    return;
  }

  var data;
  try {
    data = await response.json();
  } catch (error) {
    resetReplayView('Replay returned an invalid response.');
    renderReplayMessage('Replay returned an invalid response.');
    finishReplay(btn);
    return;
  }

  if (response.status < 200 || response.status >= 300) {
    var statusMessage = replayStatusMessage(response.status);
    resetReplayView(statusMessage);
    renderReplayMessage(statusMessage);
    finishReplay(btn);
    return;
  }

  var model;
  try {
    model = window.AtlasReplayPresentation.presentCanonicalReplay(data);
  } catch (error) {
    resetReplayView('Replay returned invalid data.');
    renderReplayMessage('Replay returned invalid data.');
    finishReplay(btn);
    return;
  }

  try {
    renderReplayModel(model);
  } catch (error) {
    resetReplayView('Replay could not be displayed.');
    renderReplayMessage('Replay could not be displayed.');
  }
  finishReplay(btn);
};

var replayButton = $('replayBtn');
if (replayButton) replayButton.addEventListener('click', window.runReplay);

})();
