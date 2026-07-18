/**
 * Atlas Chart Engine
 * TradingView Lightweight Charts v4
 *
 * Overlay Architecture:
 *   registerOverlay(name, factory) - register a new overlay type
 *   addOverlay(name, config)       - activate an overlay instance
 *   removeOverlay(id)              - deactivate an overlay
 *
 * Factory signature:
 *   factory(chart, candleSeries, config) -> { attach, detach, update, destroy }
 */
(function(root) {
  'use strict';

  var TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '12h', '24h'];
  var MIN_CANDLES = 20;

  // ---------------------------------------------------------------------------
  // Theme
  // ---------------------------------------------------------------------------
  var CHART_OPTIONS = {
    layout: {
      background: { type: 'solid', color: '#0a0e17' },
      textColor: '#8892a4',
      fontSize: 12,
      fontFamily: "'SF Mono','Fira Code','Cascadia Code',monospace",
      attributionLogo: false,
    },
    grid: {
      vertLines: { color: 'rgba(30,45,61,0.3)' },
      horzLines: { color: 'rgba(30,45,61,0.3)' },
    },
    crosshair: {
      mode: 0,
      vertLine: {
        color: 'rgba(0,229,255,0.3)',
        width: 1,
        style: 2,
        labelBackgroundColor: '#1a2332',
      },
      horzLine: {
        color: 'rgba(0,229,255,0.3)',
        width: 1,
        style: 2,
        labelBackgroundColor: '#1a2332',
      },
    },
    rightPriceScale: {
      borderColor: '#1e2d3d',
      scaleMargins: { top: 0.1, bottom: 0.25 },
    },
    timeScale: {
      borderColor: '#1e2d3d',
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 12,
      barSpacing: 6,
      minBarSpacing: 1,
      fixLeftEdge: true,
      fixRightEdge: true,
    },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true },
    handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
  };

  var CANDLE_STYLE = {
    upColor: '#26a69a',
    downColor: '#ef5350',
    borderUpColor: '#26a69a',
    borderDownColor: '#ef5350',
    wickUpColor: '#26a69a',
    wickDownColor: '#ef5350',
  };

  var VOLUME_STYLE = {
    priceFormat: { type: 'volume' },
    priceScaleId: 'vol',
  };

  var VOLUME_SCALE = {
    scaleMargins: { top: 0.8, bottom: 0 },
  };

  var PRICE_LINE_OPTS = {
    color: '#00e5ff',
    lineWidth: 1,
    lineStyle: 2,
    axisLabelVisible: true,
    title: 'LAST',
  };

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  var _chart = null;
  var _candleSeries = null;
  var _volumeSeries = null;
  var _priceLine = null;
  var _container = null;
  var _candleData = [];
  var _resizeObserver = null;

  // Overlay system
  var _overlayRegistry = {};
  var _activeOverlays = {};
  var _overlayIdSeq = 0;

  // Callbacks
  var _onCrosshair = null;
  var _onTimeframeChange = null;
  var _onDataReady = null;
  var _onDataInsufficient = null;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function _toSec(candle) {
    return Math.floor(candle.openTime / 1000);
  }

  function _dedupSort(candles) {
    var seen = {};
    var out = [];
    for (var i = 0; i < candles.length; i++) {
      var t = candles[i].openTime;
      if (seen[t]) continue;
      seen[t] = true;
      out.push(candles[i]);
    }
    out.sort(function(a, b) { return a.openTime - b.openTime; });
    return out;
  }

  function _mapCandles(arr) {
    var out = new Array(arr.length);
    for (var i = 0; i < arr.length; i++) {
      var c = arr[i];
      out[i] = {
        time: _toSec(c),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      };
    }
    return out;
  }

  function _mapVolume(arr) {
    var out = new Array(arr.length);
    for (var i = 0; i < arr.length; i++) {
      var c = arr[i];
      var isUp = c.close >= c.open;
      out[i] = {
        time: _toSec(c),
        value: c.volume,
        color: isUp ? 'rgba(38,166,154,0.5)' : 'rgba(239,83,80,0.5)',
      };
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Price line
  // ---------------------------------------------------------------------------
  function _refreshPriceLine() {
    if (!_candleSeries || _candleData.length === 0) return;
    if (_priceLine) _candleSeries.removePriceLine(_priceLine);
    var last = _candleData[_candleData.length - 1];
    _priceLine = _candleSeries.createPriceLine({
      price: last.close,
      color: PRICE_LINE_OPTS.color,
      lineWidth: PRICE_LINE_OPTS.lineWidth,
      lineStyle: PRICE_LINE_OPTS.lineStyle,
      axisLabelVisible: PRICE_LINE_OPTS.axisLabelVisible,
      title: PRICE_LINE_OPTS.title,
    });
  }

  // ---------------------------------------------------------------------------
  // Data readiness check
  // ---------------------------------------------------------------------------
  function _checkReady() {
    var ready = _candleData.length >= MIN_CANDLES;
    if (ready && _onDataReady) _onDataReady(_candleData.length);
    if (!ready && _onDataInsufficient) _onDataInsufficient(_candleData.length);
    return ready;
  }

  // ---------------------------------------------------------------------------
  // Resize
  // ---------------------------------------------------------------------------
  function _observeResize() {
    if (!root.ResizeObserver) return;
    _resizeObserver = new ResizeObserver(function(entries) {
      if (!_chart || !entries[0]) return;
      var w = entries[0].contentRect.width;
      var h = entries[0].contentRect.height;
      if (w > 0 && h > 0) _chart.resize(w, h);
    });
    _resizeObserver.observe(_container);
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  function init(container) {
    _container = container;
    _chart = root.LightweightCharts.createChart(container, CHART_OPTIONS);

    _candleSeries = _chart.addCandlestickSeries(CANDLE_STYLE);
    _volumeSeries = _chart.addHistogramSeries(VOLUME_STYLE);
    _volumeSeries.priceScale().applyOptions(VOLUME_SCALE);

    _chart.subscribeCrosshairMove(function(param) {
      if (!_onCrosshair) return;
      if (!param || !param.time) { _onCrosshair(null); return; }
      _onCrosshair({
        time: param.time,
        candle: param.seriesData.get(_candleSeries) || null,
        volume: param.seriesData.get(_volumeSeries) || null,
      });
    });

    _observeResize();
    return _chart;
  }

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------
  function setData(candles) {
    var clean = _dedupSort(candles);
    if (clean.length === 0) return;

    _candleData = clean;
    _candleSeries.setData(_mapCandles(clean));
    _volumeSeries.setData(_mapVolume(clean));
    _refreshPriceLine();
    _broadcastUpdate();

    if (_checkReady()) {
      _chart.timeScale().fitContent();
    }
  }

  function updateCandle(candle) {
    if (!candle) return;
    var t = _toSec(candle);

    _candleSeries.update({
      time: t,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    });
    _volumeSeries.update({
      time: t,
      value: candle.volume,
      color: candle.close >= candle.open ? 'rgba(38,166,154,0.5)' : 'rgba(239,83,80,0.5)',
    });

    // sync internal buffer
    if (_candleData.length > 0) {
      var last = _candleData[_candleData.length - 1];
      if (last.openTime === candle.openTime) {
        _candleData[_candleData.length - 1] = candle;
      } else {
        _candleData.push(candle);
      }
    } else {
      _candleData.push(candle);
    }

    _refreshPriceLine();
    _broadcastUpdate();
    _checkReady();
  }

  function _broadcastUpdate() {
    var keys = Object.keys(_activeOverlays);
    for (var i = 0; i < keys.length; i++) {
      var ol = _activeOverlays[keys[i]];
      if (ol && ol.instance && ol.instance.update) ol.instance.update(_candleData);
    }
  }

  // ---------------------------------------------------------------------------
  // Timeframe
  // ---------------------------------------------------------------------------
  function onTimeframeChange(cb) { _onTimeframeChange = cb; }

  function setTimeframe(tf) {
    if (_onTimeframeChange) _onTimeframeChange(tf);
  }

  // ---------------------------------------------------------------------------
  // Crosshair
  // ---------------------------------------------------------------------------
  function onCrosshairMove(cb) { _onCrosshair = cb; }

  // ---------------------------------------------------------------------------
  // Data readiness callbacks
  // ---------------------------------------------------------------------------
  function onDataReady(cb) { _onDataReady = cb; }
  function onDataInsufficient(cb) { _onDataInsufficient = cb; }

  // ---------------------------------------------------------------------------
  // Overlay system
  // ---------------------------------------------------------------------------
  function registerOverlay(name, factory) {
    if (_overlayRegistry[name]) return;
    _overlayRegistry[name] = factory;
  }

  function addOverlay(name, config) {
    var factory = _overlayRegistry[name];
    if (!factory) return null;
    var id = 'ov_' + (++_overlayIdSeq);
    var instance = factory(_chart, _candleSeries, config || {});
    _activeOverlays[id] = { name: name, instance: instance };
    if (instance.attach) instance.attach();
    return id;
  }

  function removeOverlay(id) {
    var ol = _activeOverlays[id];
    if (!ol) return;
    if (ol.instance && ol.instance.detach) ol.instance.detach();
    if (ol.instance && ol.instance.destroy) ol.instance.destroy();
    delete _activeOverlays[id];
  }

  function removeAllOverlays() {
    var keys = Object.keys(_activeOverlays);
    for (var i = 0; i < keys.length; i++) removeOverlay(keys[i]);
  }

  // ---------------------------------------------------------------------------
  // Theme
  // ---------------------------------------------------------------------------
  function applyOptions(opts) { if (_chart) _chart.applyOptions(opts); }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------
  function getChart()        { return _chart; }
  function getCandleSeries() { return _candleSeries; }
  function getVolumeSeries() { return _volumeSeries; }
  function getCandleData()   { return _candleData; }
  function getCandleCount()  { return _candleData.length; }
  function hasEnoughData()   { return _candleData.length >= MIN_CANDLES; }

  // ---------------------------------------------------------------------------
  // Destroy
  // ---------------------------------------------------------------------------
  function destroy() {
    removeAllOverlays();
    if (_resizeObserver) { _resizeObserver.disconnect(); _resizeObserver = null; }
    if (_chart) { _chart.remove(); _chart = null; }
    _candleSeries = null;
    _volumeSeries = null;
    _priceLine = null;
    _candleData = [];
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  root.AtlasChart = {
    init: init,
    setData: setData,
    updateCandle: updateCandle,
    setTimeframe: setTimeframe,
    onTimeframeChange: onTimeframeChange,
    onCrosshairMove: onCrosshairMove,
    onDataReady: onDataReady,
    onDataInsufficient: onDataInsufficient,
    registerOverlay: registerOverlay,
    addOverlay: addOverlay,
    removeOverlay: removeOverlay,
    removeAllOverlays: removeAllOverlays,
    applyOptions: applyOptions,
    getChart: getChart,
    getCandleSeries: getCandleSeries,
    getVolumeSeries: getVolumeSeries,
    getCandleData: getCandleData,
    getCandleCount: getCandleCount,
    hasEnoughData: hasEnoughData,
    destroy: destroy,
    TIMEFRAMES: TIMEFRAMES,
    MIN_CANDLES: MIN_CANDLES,
  };

})(window);
