/* Atlas Dashboard v2.0 — Trading Terminal */
(function() {
'use strict';

var API = '';
var API_KEY = window.__ATLAS_API_KEY || '';
var REFRESH = 3000;
var CANDLE_REFRESH = 2000;
var chartCurrentTF = '1h';
var chartLastCandles = [];
var chartPrevFinalizedCount = 0;
var chartFirstLoad = true;
var lastLogCount = 0;
var lastLogId = 0;
var currentPrice = null;
var pipelineDirection = null;

// Request deduplication: track in-flight fetches to prevent duplicates
var inflight = {};
function authHeaders() {
  return API_KEY ? { 'X-API-Key': API_KEY } : {};
}
function dedupedFetch(key, url) {
  if (inflight[key]) return inflight[key];
  inflight[key] = fetch(url, { headers: authHeaders() })
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
  dot.className = 'status-dot ' + (ok ? 'connected' : 'disconnected');
  txt.textContent = ok ? 'Connected' : 'Disconnected';
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
    console.log('[Market] API response:', d);
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
    console.log('[Analysis] API response keys:', Object.keys(d), 'trend:', d.trend ? d.trend['1H'] : 'none');
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
    console.log('[Structure] API response: pattern=' + d.structure + ' dir=' + d.direction + ' score=' + d.score + ' confidence=' + d.confidence);
    $('structureStatus').textContent = d.structure ? 'Live' : 'N/A';
    setClass($('structPattern'), trendClass(d.structure));
    $('structPattern').textContent = d.structure || '--';
    setClass($('structDir'), trendClass(d.direction));
    $('structDir').textContent = d.direction || '--';
    $('structBOS').textContent = d.lastBOS ? d.lastBOS.type + ' @ ' + fmtUSD(d.lastBOS.price) : 'None';
    setClass($('structScore'), d.score != null && d.score > 60 ? 'bullish' : d.score != null && d.score < 40 ? 'bearish' : '');
    $('structScore').textContent = d.score != null ? d.score : '--';
    $('structConf').textContent = d.confidence != null ? d.confidence + '%' : '--';
    console.log('[Structure] Rendered: pattern=' + d.structure + ' dir=' + d.direction + ' BOS=' + (d.lastBOS ? d.lastBOS.type : 'None') + ' score=' + d.score + ' conf=' + d.confidence);
  } catch(e) {}
}

async function fetchIndicators() {
  try {
    // RSI — API returns { timeframe, candleCount, rsi: { ready, value, state, ... } }
    var rsiResp = await dedupedFetch('rsi-' + chartCurrentTF, API + '/api/indicators/rsi?timeframe=' + chartCurrentTF);
    var rsi = rsiResp && rsiResp.rsi ? rsiResp.rsi : null;
    if (rsi) {
      console.log('[RSI] API response:', rsiResp, '| Parsed:', rsi);
      $('rsiStatus').textContent = rsi.ready ? 'Ready' : 'N/A';
      setClass($('rsiValue'), rsi.value > 70 ? 'bearish' : rsi.value < 30 ? 'bullish' : '');
      $('rsiValue').textContent = rsi.value != null ? rsi.value.toFixed(1) : '--';
      $('rsiState').textContent = rsi.state || '--';
      $('rsiInterp').textContent = rsi.signal || '--';
      console.log('[RSI] Rendered: value=' + rsi.value + ' state=' + rsi.state + ' signal=' + rsi.signal);
    }

    // EMA — API returns { symbol, timeframe, periods: { "9":{value,trend,ready}, "20":{...}, ... } }
    var emaResp = await dedupedFetch('ema-' + chartCurrentTF, API + '/api/indicators/ema?timeframe=' + chartCurrentTF);
    var emaPeriods = emaResp && emaResp.periods ? emaResp.periods : null;
    if (emaPeriods) {
      console.log('[EMA] API response:', emaResp, '| Periods:', emaPeriods);
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
      console.log('[EMA] Rendered: EMA20=' + ema20.value + ' trend=' + ema20.trend);
    }

    // MACD
    var macd = await dedupedFetch('macd-' + chartCurrentTF, API + '/api/macd?timeframe=' + chartCurrentTF);
    if (macd && macd.ready !== undefined) {
      console.log('[MACD] API response:', macd);
      $('macdStatus').textContent = macd.ready ? 'Ready' : 'N/A';
      setClass($('macdTrend'), trendClass(macd.trend));
      $('macdTrend').textContent = macd.trend || '--';
      $('macdHist').textContent = macd.histogram != null ? macd.histogram.toFixed(4) : '--';
      $('macdSignal').textContent = macd.signal != null ? macd.signal.toFixed(6) : '--';
      $('macdInterp').textContent = macd.interpretation || (macd.crossover && macd.crossover !== 'None' ? 'Crossover: ' + macd.crossover : macd.trend || '--');
      console.log('[MACD] Rendered: macd=' + macd.macd + ' signal=' + macd.signal + ' trend=' + macd.trend);
    }

    // ATR
    var atr = await dedupedFetch('atr-' + chartCurrentTF, API + '/api/atr?timeframe=' + chartCurrentTF);
    if (atr && atr.ready !== undefined) {
      console.log('[ATR] API response:', atr);
      $('atrStatus').textContent = atr.ready ? 'Ready' : 'N/A';
      $('atrValue').textContent = atr.atr != null ? atr.atr.toFixed(2) : '--';
      $('atrPct').textContent = atr.atrPercentage != null ? atr.atrPercentage.toFixed(2) + '%' : '--';
      setClass($('atrVol'), volClass(atr.volatilityLevel));
      $('atrVol').textContent = atr.volatilityLevel || '--';
      $('atrTrend').textContent = atr.volatilityTrend || '--';
      console.log('[ATR] Rendered: atr=' + atr.atr + ' vol=' + atr.volatilityLevel + ' trend=' + atr.volatilityTrend);
    }

    // Bollinger — API returns { middleBand, upperBand, lowerBand, squeeze, pricePosition, lastClose, bandwidth, ... }
    var bb = await dedupedFetch('bollinger-' + chartCurrentTF, API + '/api/bollinger?timeframe=' + chartCurrentTF);
    if (bb && bb.ready !== undefined) {
      console.log('[Bollinger] API response:', bb);
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
      console.log('[Bollinger] Rendered: mid=' + bb.middleBand + ' upper=' + bb.upperBand + ' lower=' + bb.lowerBand + ' squeeze=' + bb.squeeze);
    }
  } catch(e) {}
}

async function fetchMarketRegime() {
  try {
    var d = await dedupedFetch('market-regime-' + chartCurrentTF, API + '/api/market-regime?timeframe=' + chartCurrentTF);
    if (!d || !d.regime) return;
    console.log('[MarketRegime] API response: regime=' + d.regime + ' conf=' + d.confidence + ' trend=' + d.trendScore + ' range=' + d.rangeScore + ' vol=' + d.volatility);
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
    console.log('[Confluence] API response: score=' + d.score + ' bias=' + d.bias + ' confidence=' + d.confidence);
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

async function fetchRisk() {
  try {
    var price = currentPrice;
    var dir = pipelineDirection;
    if (!price || !dir) return;
    var d = await dedupedFetch('risk-' + chartCurrentTF + '-' + dir, API + '/api/risk?timeframe=' + chartCurrentTF + '&entryPrice=' + price + '&direction=' + dir);
    if (!d) return;
    console.log('[Risk] API response: allowed=' + d.tradeAllowed + ' dir=' + d.direction + ' SL=' + d.stopLoss + ' TP=' + d.takeProfit);
    $('riskStatus').textContent = d.tradeAllowed ? 'Allowed' : 'Rejected';
    setClass($('riskDir'), d.direction === 'BUY' ? 'bullish' : 'bearish');
    $('riskDir').textContent = d.direction || '--';
    $('riskEntry').textContent = d.entryPrice != null ? fmtUSD(d.entryPrice) : '--';
    $('riskSL').textContent = d.stopLoss != null ? fmtUSD(d.stopLoss) : '--';
    setClass($('riskSL'), 'bearish');
    $('riskTP').textContent = d.takeProfit != null ? fmtUSD(d.takeProfit) : '--';
    setClass($('riskTP'), 'bullish');
    $('riskRR').textContent = d.riskReward != null ? '1:' + d.riskReward : '--';

    var verdict = $('riskVerdict');
    var icon = $('riskVerdictIcon');
    var text = $('riskVerdictText');
    var rej = $('riskRejection');
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

async function fetchAdvanceRisk() {
  try {
    var price = currentPrice;
    var dir = pipelineDirection;
    if (!price || !dir) return;
    var d = await dedupedFetch('advance-risk-' + chartCurrentTF + '-' + dir, API + '/api/advance-risk?timeframe=' + chartCurrentTF + '&entryPrice=' + price + '&direction=' + dir);
    if (!d) return;
    console.log('[AdvanceRisk] API: allowed=' + d.tradeAllowed + ' dir=' + d.direction + ' pos=' + d.positionSize + ' SL=' + d.stopLoss + ' TP=' + d.takeProfit);
    $('advanceRiskStatus').textContent = d.tradeAllowed ? 'Allowed' : 'Rejected';
    $('advPosSize').textContent = d.positionSize != null ? d.positionSize : '--';
    $('advDollarRisk').textContent = d.dollarRisk != null ? fmtUSD(d.dollarRisk) : '--';
    $('advSL').textContent = d.stopLoss != null ? fmtUSD(d.stopLoss) : '--';
    setClass($('advSL'), 'bearish');
    $('advTP').textContent = d.takeProfit != null ? fmtUSD(d.takeProfit) : '--';
    setClass($('advTP'), 'bullish');
    $('advRR').textContent = d.riskReward != null ? '1:' + d.riskReward : '--';
    $('advSession').textContent = d.session || '--';
    $('advDailyLoss').textContent = d.dailyPnl != null ? fmtUSD(d.dailyPnl) : (d.state && d.state.dailyPnl != null ? fmtUSD(d.state.dailyPnl) : '--');
    $('advConsecLoss').textContent = d.state && d.state.consecutiveLosses != null ? d.state.consecutiveLosses : '--';
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
    console.log('[MTFConf] API: allowed=' + d.mtfAllowed + ' conf=' + d.confidence + '% align=' + d.alignmentScore + '%');
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
    console.log('[PaperTrades] API response: open=' + (d.open || []).length + ' closed=' + (d.closed || []).length + ' balance=' + d.balance);
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
      list.innerHTML = '<div class="paper-empty">No trades yet</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < allTrades.length; i++) {
      var t = allTrades[i];
      var dirCls = t.direction === 'BUY' ? 'dir-buy' : 'dir-sell';
      var stCls = t.status === 'OPEN' || t.status === 'ACTIVE' ? 'status-open' : 'status-closed';
      var pnlVal = t.pnl != null ? t.pnl : '--';
      var pnlText = t.pnl != null ? (t.pnl >= 0 ? '+$' : '-$') + Math.abs(t.pnl).toFixed(2) : '--';
      var pnlCls = t.pnl == null ? '' : t.pnl >= 0 ? 'pnl-pos' : 'pnl-neg';
      var reason = t.exitReason || t.status || '';
      html += '<div class="paper-row">' +
        '<span>' + fmtShortTime(t.entryTime || t.timestamp) + '</span>' +
        '<span class="' + dirCls + '">' + t.direction + '</span>' +
        '<span>' + fmtUSD(t.entryPrice) + '</span>' +
        '<span>' + fmtUSD(t.stopLoss) + '</span>' +
        '<span>' + fmtUSD(t.takeProfit) + '</span>' +
        '<span class="' + stCls + '">' + (t.status || '--') + '</span>' +
        '<span class="' + pnlCls + '">' + pnlText + '</span>' +
        '</div>';
    }
    list.innerHTML = html;

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
    console.log('[PaperTrades] Rendered: wins=' + wins + ' losses=' + losses + ' balance=' + d.balance + ' pf=' + perf.profitFactor + ' return=' + perf.netReturnPct);

    // Render closed trades in performance history
    var histList = $('perfSignals');
    if (closedTrades.length === 0) {
      histList.innerHTML = '<div class="perf-empty">No trade history</div>';
      return;
    }
    var histHtml = '';
    var shown = closedTrades.slice(-20).reverse();
    for (var j = 0; j < shown.length; j++) {
      var ct = shown[j];
      var biasCls = ct.direction === 'BUY' ? 'dir-buy' : 'dir-sell';
      var outCls = ct.pnl > 0 ? 'outcome-correct' : ct.pnl < 0 ? 'outcome-incorrect' : 'outcome-neutral';
      var outcomeText = ct.pnl > 0 ? 'WIN' : ct.pnl < 0 ? 'LOSS' : 'BREAKEVEN';
      histHtml += '<div class="perf-row">' +
        '<span>' + fmtShortTime(ct.entryTime) + '</span>' +
        '<span class="' + biasCls + '">' + ct.direction + '</span>' +
        '<span>' + (ct.confidence || '--') + '</span>' +
        '<span>' + fmtUSD(ct.entryPrice) + '</span>' +
        '<span>' + fmtUSD(ct.exitPrice) + '</span>' +
        '<span class="' + outCls + '">' + outcomeText + '</span>' +
        '</div>';
    }
    histList.innerHTML = histHtml;
    $('perfStatus').textContent = closedTrades.length + ' trades';
  } catch(e) {}
}

async function fetchPerformance() {
  try {
    var d = await dedupedFetch('analytics', API + '/api/analytics');
    if (!d) return;
    console.log('[Analytics] API response keys:', Object.keys(d));
    var acc = d.accuracy || {};
    var gen = d.general || {};
    var conf = d.confidence || {};
    var perf = d.performance || {};
    $('perfWinRate').textContent = perf.winRate != null ? perf.winRate + '%' : '0%';
    setClass($('perfWinRate'), perf.winRate > 50 ? 'bullish' : '');
    $('perfLossRate').textContent = perf.lossRate != null ? perf.lossRate + '%' : '0%';
    setClass($('perfLossRate'), perf.lossRate > 50 ? 'bearish' : '');
    $('perfTotal').textContent = gen.totalSignals || 0;
    $('perfAvgConf').textContent = conf.averageConfidence != null ? conf.averageConfidence.toFixed(0) : '0';
    $('perfStatus').textContent = gen.totalSignals + ' signals';
    console.log('[Analytics] Rendered: winRate=' + perf.winRate + ' lossRate=' + perf.lossRate + ' total=' + gen.totalSignals + ' avgConf=' + conf.averageConfidence);

    // Fetch last 20 signals from backtest
    var bt = await dedupedFetch('backtest-' + chartCurrentTF, API + '/api/backtest?timeframe=' + chartCurrentTF + '&predictionCandles=5&warmupCandles=50');
    var sigs = (bt && bt.signals) ? bt.signals.slice(-20).reverse() : [];
    var list = $('perfSignals');
    if (sigs.length === 0) {
      list.innerHTML = '<div class="perf-empty">No signal history</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < sigs.length; i++) {
      var s = sigs[i];
      var biasCls = s.overallBias === 'Bullish' ? 'dir-buy' : s.overallBias === 'Bearish' ? 'dir-sell' : '';
      var outCls = s.outcome === 'correct' ? 'outcome-correct' : s.outcome === 'incorrect' ? 'outcome-incorrect' : 'outcome-neutral';
      html += '<div class="perf-row">' +
        '<span>' + fmtShortTime(s.timestamp) + '</span>' +
        '<span class="' + biasCls + '">' + (s.overallBias || '--') + '</span>' +
        '<span>' + (s.confidence || '--') + '</span>' +
        '<span>' + fmtUSD(s.priceAtSignal) + '</span>' +
        '<span>' + fmtUSD(s.priceAfter) + '</span>' +
        '<span class="' + outCls + '">' + (s.outcome || '--') + '</span>' +
        '</div>';
    }
    list.innerHTML = html;
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
      div.className = 'log-entry log-' + level;
      var time = fmtTime(entry.timestamp);
      var meta = entry.meta && Object.keys(entry.meta).length ? ' ' + JSON.stringify(entry.meta) : '';
      div.innerHTML = '<span class="log-time">[' + time + ']</span>[' + (entry.level || 'INFO').toUpperCase() + '] ' + entry.message + meta;
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
  AtlasChart.init(container);
  AtlasChart.onCrosshairMove(function(data) { updateCrosshair(data); });
  updateWaitingOverlay(0);
  initTimeframeSelector();
  fetchCandles();
  setInterval(fetchCandles, CANDLE_REFRESH);
}

function startPolling() {
  fetchMarket();
  fetchAnalysis();
  fetchStructure();
  fetchIndicators();
  fetchConfluence();
  fetchMarketRegime();
  fetchRisk();
  fetchAdvanceRisk();
  fetchMtfConfirmation();
  fetchPaperTrades();
  fetchInspector();
  fetchLogs();
  updatePipelineDirection();

  setInterval(function() {
    fetchMarket();
    fetchAnalysis();
    fetchStructure();
    fetchIndicators();
    fetchConfluence();
    fetchMarketRegime();
    fetchRisk();
    fetchAdvanceRisk();
    fetchMtfConfirmation();
    fetchPaperTrades();
    fetchInspector();
    fetchLogs();
    updatePipelineDirection();
  }, REFRESH);

  initChart();
}

startPolling();

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
    var gatesHtml = '';
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
      gatesHtml += '<div class="inspector-gate-row"><span>' + gateLabels[gk] + '</span><span class="' + statusCls + '">' + statusText + '</span><span>' + detail + '</span></div>';
    }
    $('inspGates').innerHTML = gatesHtml;

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
      tradeEl.style.display = '';
      $('inspEntry').textContent = fmtUSD(v.trade.entryPrice);
      $('inspSL').textContent = fmtUSD(v.trade.stopLoss);
      $('inspTP').textContent = fmtUSD(v.trade.takeProfit);
      $('inspPosSize').textContent = v.trade.positionSize;
      $('inspRR').textContent = '1:' + v.trade.riskReward;
    } else {
      tradeEl.style.display = 'none';
    }

    $('inspectorStatus').textContent = 'Cycle #' + (d.cycle || 0);
  } catch(e) {}
}

// ---------------------------------------------------------------------------
// Strategy Replay
// ---------------------------------------------------------------------------
window.runReplay = async function() {
  var btn = $('replayBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Running...'; btn.className = 'replay-btn loading'; }

  $('replayStatus').textContent = 'Running...';
  $('replayTradesList').innerHTML = '<div class="replay-empty">Replaying 30 days of candles...</div>';
  $('replayRejectionsList').style.display = 'none';
  $('replayRejectionsHeader').style.display = 'none';

  try {
    var d = await fetch(API + '/api/strategy/replay?timeframe=1h&days=30', { headers: authHeaders() });
    var data = await d.json();

    if (data.error) {
      $('replayTradesList').innerHTML = '<div class="replay-empty">Error: ' + data.error + '</div>';
      $('replayStatus').textContent = 'Error';
      if (btn) { btn.disabled = false; btn.textContent = 'Run 30D'; btn.className = 'replay-btn'; }
      return;
    }

    var s = data.stats || {};
    $('replayTrades').textContent = s.totalTrades || 0;
    $('replayWinRate').textContent = (s.winRate || 0) + '%';
    setClass($('replayWinRate'), s.winRate > 50 ? 'bullish' : s.winRate < 40 ? 'bearish' : '');
    $('replayPF').textContent = s.profitFactor || '0';
    setClass($('replayPF'), s.profitFactor > 1 ? 'bullish' : s.profitFactor > 0 ? 'bearish' : '');
    $('replayExpectancy').textContent = '$' + (s.expectancy || 0).toFixed(2);
    setClass($('replayExpectancy'), s.expectancy > 0 ? 'bullish' : 'bearish');
    $('replayAvgR').textContent = (s.averageR || 0) + 'R';
    setClass($('replayAvgR'), s.averageR > 0 ? 'bullish' : 'bearish');
    $('replayDD').textContent = (s.maxDrawdownPct || 0) + '%';
    setClass($('replayDD'), s.maxDrawdownPct > 5 ? 'bearish' : '');
    $('replayPnl').textContent = (s.netPnl >= 0 ? '+$' : '-$') + Math.abs(s.netPnl || 0).toFixed(2);
    setClass($('replayPnl'), s.netPnl >= 0 ? 'pnl-pos' : 'pnl-neg');
    $('replayLongs').textContent = (s.longs ? s.longs.wins : 0) + '/' + (s.longs ? s.longs.losses : 0);
    setClass($('replayLongs'), s.longs && s.longs.winRate > 50 ? 'bullish' : '');
    $('replayShorts').textContent = (s.shorts ? s.shorts.wins : 0) + '/' + (s.shorts ? s.shorts.losses : 0);
    setClass($('replayShorts'), s.shorts && s.shorts.winRate > 50 ? 'bullish' : '');
    $('replayRejections').textContent = s.totalRejections || 0;
    $('replayStatus').textContent = (data.candlesAnalyzed || 0) + ' candles | ' + (data.calculationTime || 0) + 'ms';

    var trades = data.trades || [];
    var list = $('replayTradesList');
    if (trades.length === 0) {
      list.innerHTML = '<div class="replay-empty">No trades generated — market was neutral throughout</div>';
    } else {
      var html = '';
      for (var i = 0; i < trades.length; i++) {
        var t = trades[i];
        var dirCls = t.direction === 'BUY' ? 'dir-buy' : 'dir-sell';
        var outCls = t.win ? 'outcome-correct' : 'outcome-incorrect';
        var outcomeText = t.win ? 'WIN' : 'LOSS';
        var rText = (t.rMultiple >= 0 ? '+' : '') + (t.rMultiple || 0) + 'R';
        var rCls = t.rMultiple > 0 ? 'pnl-pos' : 'pnl-neg';
        var durText = t.duration != null ? t.duration + 'c' : '--';
        html += '<div class="replay-row">' +
          '<span>' + t.tradeId + '</span>' +
          '<span class="' + dirCls + '">' + t.direction + '</span>' +
          '<span>' + fmtUSD(t.entry) + '</span>' +
          '<span>' + fmtUSD(t.exit) + '</span>' +
          '<span>' + fmtUSD(t.stopLoss) + '</span>' +
          '<span>' + fmtUSD(t.takeProfit) + '</span>' +
          '<span class="' + rCls + '">' + rText + '</span>' +
          '<span>' + durText + '</span>' +
          '<span class="' + outCls + '">' + outcomeText + '</span>' +
          '</div>';
      }
      list.innerHTML = html;
    }

    var rejections = data.rejections || [];
    if (rejections.length > 0) {
      $('replayRejectionsHeader').style.display = '';
      $('replayRejCount').textContent = rejections.length + ' total';
      var rejHtml = '';
      for (var j = 0; j < rejections.length; j++) {
        var r = rejections[j];
        var time = fmtShortTime(r.timestamp);
        rejHtml += '<div class="replay-rej-row"><span>' + time + '</span><span>' + (r.reason || '--') + '</span></div>';
      }
      $('replayRejectionsList').innerHTML = rejHtml;
    }
  } catch(e) {
    $('replayTradesList').innerHTML = '<div class="replay-empty">Error: ' + e.message + '</div>';
    $('replayStatus').textContent = 'Error';
  }

  if (btn) { btn.disabled = false; btn.textContent = 'Run 30D'; btn.className = 'replay-btn'; }
};

window.toggleRejections = function() {
  var el = $('replayRejectionsList');
  el.style.display = el.style.display === 'none' ? '' : 'none';
};

})();
