// 試しのページの画面の動き(仕様 job-20261030-001)。
// 何も外へ送らず、何も保存しない。位置は誤差と時刻だけを持ち、緯度経度は変数にも画面にも置かない。
(function () {
  'use strict';

  var PAGE_VERSION = 'geo-exif spike 1';
  var HEAD_BYTES = 256 * 1024; // 写真はファイルの先頭だけを読む(EXIF は先頭の 64KB 以内)
  var GEO_OPTIONS = { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 };
  var DURATION_S = 60;
  var TICK_MS = 1000;
  var GEO_ERROR = { 1: '断った', 2: '取れない', 3: '時間切れ' };

  var photoRows = [];
  var geoRows = [];
  var geoSummary = [];
  var deviceText = '';

  function $(id) { return document.getElementById(id); }

  function pad(n, w) { var s = String(n); while (s.length < (w || 2)) s = '0' + s; return s; }

  // 端末の時計の表記(時差つき)。
  function fmtLocal(ms) {
    var d = new Date(ms);
    var off = -d.getTimezoneOffset();
    var sign = off >= 0 ? '+' : '-';
    off = Math.abs(off);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) +
      ' ' + sign + pad(Math.floor(off / 60)) + ':' + pad(off % 60);
  }

  function fmtSize(n) {
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
    return n + ' B';
  }

  function cell(tr, text) {
    var td = document.createElement('td');
    td.textContent = text;
    tr.appendChild(td);
  }

  function renderTable(tableId, rows, columns) {
    var tbody = $(tableId).querySelector('tbody');
    tbody.textContent = '';
    rows.forEach(function (row) {
      var tr = document.createElement('tr');
      columns.forEach(function (c) { cell(tr, row[c]); });
      tbody.appendChild(tr);
    });
  }

  // --- 1. 端末 -------------------------------------------------------------

  function guessBrowserAndOs(ua) {
    var os = '不明', browser = '不明', m;
    if ((m = ua.match(/iPhone OS (\d+[_\d]*)/)) || (m = ua.match(/CPU OS (\d+[_\d]*)/))) os = 'iOS ' + m[1].replace(/_/g, '.');
    else if ((m = ua.match(/Android (\d+(\.\d+)*)/))) os = 'Android ' + m[1];
    else if ((m = ua.match(/Mac OS X (\d+[_\d]*)/))) os = 'macOS ' + m[1].replace(/_/g, '.');
    else if ((m = ua.match(/Windows NT (\d+\.\d+)/))) os = 'Windows NT ' + m[1];
    if ((m = ua.match(/EdgiOS\/([\d.]+)/)) || (m = ua.match(/EdgA\/([\d.]+)/)) || (m = ua.match(/Edg\/([\d.]+)/))) browser = 'Edge ' + m[1];
    else if ((m = ua.match(/CriOS\/([\d.]+)/))) browser = 'Chrome(iOS) ' + m[1];
    else if ((m = ua.match(/FxiOS\/([\d.]+)/))) browser = 'Firefox(iOS) ' + m[1];
    else if ((m = ua.match(/SamsungBrowser\/([\d.]+)/))) browser = 'Samsung Internet ' + m[1];
    else if ((m = ua.match(/Firefox\/([\d.]+)/))) browser = 'Firefox ' + m[1];
    else if ((m = ua.match(/Chrome\/([\d.]+)/))) browser = 'Chrome ' + m[1];
    else if ((m = ua.match(/Version\/([\d.]+).*Safari/))) browser = 'Safari ' + m[1];
    return { os: os, browser: browser };
  }

  function showDevice() {
    var ua = navigator.userAgent || '';
    var g = guessBrowserAndOs(ua);
    var lines = [
      'ページの版: ' + PAGE_VERSION,
      'ブラウザ(ページが読んだ値): ' + g.browser,
      'OS(ページが読んだ値): ' + g.os,
      'userAgent: ' + ua
    ];
    deviceText = lines.join('\n');
    $('device').textContent = deviceText;
    var uad = navigator.userAgentData;
    if (uad && typeof uad.getHighEntropyValues === 'function') {
      uad.getHighEntropyValues(['platformVersion', 'fullVersionList']).then(function (v) {
        var brands = (v.fullVersionList || []).map(function (b) { return b.brand + ' ' + b.version; }).join(' / ');
        lines.push('userAgentData: ' + (v.platform || '') + ' ' + (v.platformVersion || '') + ' / ' + brands);
        deviceText = lines.join('\n');
        $('device').textContent = deviceText;
      }, function () { /* 読めなければ userAgent だけ */ });
    }
  }

  // --- 2. 写真 -------------------------------------------------------------

  function readHead(file) {
    var part = file.slice(0, HEAD_BYTES);
    if (typeof part.arrayBuffer === 'function') return part.arrayBuffer();
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
      r.readAsArrayBuffer(part);
    });
  }

  function onPhotos() {
    var input = $('photos');
    var files = Array.prototype.slice.call(input.files || []);
    if (files.length === 0) return;
    var route = $('route').value;
    var option = '位置情報 ' + $('opt-location').value + ' / 形式 ' + $('opt-format').value;
    $('photo-status').textContent = files.length + ' 枚を読んでいます…';
    var chain = Promise.resolve();
    files.forEach(function (f) {
      chain = chain.then(function () {
        return readHead(f).then(function (buf) {
          var r = GeoExif.classify(new Uint8Array(buf), f.size > HEAD_BYTES);
          return { format: r.format, label: r.label, gps: r.gpsLabel };
        }, function () {
          return { format: '読めない', label: 'ファイルを読めない', gps: '不明' };
        }).then(function (r) {
          photoRows.push({
            no: String(photoRows.length + 1),
            route: route,
            option: option,
            name: f.name,
            type: f.type || '(空)',
            size: fmtSize(f.size),
            lastModified: f.lastModified ? fmtLocal(f.lastModified) : '(なし)',
            format: r.format,
            date: r.label,
            gps: r.gps
          });
        });
      });
    });
    chain.then(function () {
      renderTable('photo-table', photoRows, ['no', 'route', 'option', 'name', 'type', 'size', 'lastModified', 'format', 'date', 'gps']);
      $('photo-status').textContent = files.length + ' 枚を表に足しました(合計 ' + photoRows.length + ' 枚)。';
      input.value = ''; // 同じ写真をもう一度選べるように
      updateResult();
    });
  }

  // --- 3. 位置 -------------------------------------------------------------

  var watchId = null;
  var timerId = null;

  function permissionState() {
    if (!navigator.permissions || typeof navigator.permissions.query !== 'function') return Promise.resolve('読めない(非対応)');
    return navigator.permissions.query({ name: 'geolocation' }).then(function (p) { return p.state; }, function () { return '読めない'; });
  }

  function startGeo() {
    if (timerId !== null) return;
    var place = $('place').value;
    var btn = $('geo-start');
    geoRows = [];
    geoSummary = ['場所: ' + place, '開始: ' + fmtLocal(Date.now())];
    renderTable('geo-table', geoRows, []);

    var geoApi = navigator.geolocation;
    if (!geoApi || typeof geoApi.watchPosition !== 'function') {
      geoRows.push({ n: '0', clock: '0.0', acc: '', got: '', age: '', reason: '非対応' });
      geoSummary.push('結果: 非対応(位置の API が無い)');
      finishGeo();
      return;
    }

    btn.disabled = true;
    var t0 = performance.now();
    var tick = 0;
    var last = null;          // { accuracy, timestamp }(緯度経度は持たない)
    var gotThisTick = false;
    var reasonThisTick = '';
    var fixCount = 0;
    var firstFixS = null;
    var bestAcc = null;

    permissionState().then(function (s) { geoSummary.push('許可の状態(開始時): ' + s); });

    function onPos(p) {
      last = { accuracy: p.coords.accuracy, timestamp: p.timestamp };
      gotThisTick = true;
      fixCount += 1;
      if (firstFixS === null) firstFixS = ((performance.now() - t0) / 1000).toFixed(1);
      if (bestAcc === null || p.coords.accuracy < bestAcc) bestAcc = p.coords.accuracy;
    }
    function onErr(e) {
      reasonThisTick = GEO_ERROR[e.code] || ('そのほか ' + e.code);
      if (e.code === 1) stop('断った'); // 断られたら続けても取れない
    }

    function addRow() {
      var now = performance.now();
      geoRows.push({
        n: String(tick),
        clock: ((now - t0) / 1000).toFixed(1),
        acc: last ? String(Math.round(last.accuracy)) : '',
        got: gotThisTick ? '取れた' : '—',
        age: last ? ((Date.now() - last.timestamp) / 1000).toFixed(1) : '',
        reason: reasonThisTick
      });
      gotThisTick = false;
      reasonThisTick = '';
      renderTable('geo-table', geoRows, ['n', 'clock', 'acc', 'got', 'age', 'reason']);
      $('geo-status').textContent = tick + ' / ' + DURATION_S + ' 秒' + (last ? '・誤差 ' + Math.round(last.accuracy) + ' m' : '・まだ取れていない');
    }

    function stop(why) {
      if (timerId === null) return;
      tick += 1;
      if (why) reasonThisTick = why;
      addRow();
      clearInterval(timerId);
      timerId = null;
      if (watchId !== null) geoApi.clearWatch(watchId);
      watchId = null;
      geoSummary.push('終わり: ' + (why || DURATION_S + ' 秒たった'));
      geoSummary.push('取れた回数: ' + fixCount + '・最初に取れた時計の秒: ' + (firstFixS === null ? '(取れなかった)' : firstFixS) +
        '・一番よい誤差 m: ' + (bestAcc === null ? '' : Math.round(bestAcc)));
      permissionState().then(function (s) {
        geoSummary.push('許可の状態(終わり): ' + s);
        finishGeo();
      });
    }

    timerId = setInterval(function () {
      tick += 1;
      if (tick >= DURATION_S) { tick -= 1; stop(''); return; }
      addRow();
    }, TICK_MS);
    watchId = geoApi.watchPosition(onPos, onErr, GEO_OPTIONS);
  }

  function finishGeo() {
    renderTable('geo-table', geoRows, ['n', 'clock', 'acc', 'got', 'age', 'reason']);
    $('geo-status').textContent = geoSummary[geoSummary.length - 1] || '';
    $('geo-start').disabled = false;
    updateResult();
  }

  // --- 4. 結果 -------------------------------------------------------------

  function tsv(header, rows, columns) {
    return [header.join('\t')].concat(rows.map(function (r) {
      return columns.map(function (c) { return r[c]; }).join('\t');
    })).join('\n');
  }

  function buildResult() {
    return [
      '【試しのページの結果】' + fmtLocal(Date.now()),
      '(緯度と経度は含めていません)',
      '',
      '■ 端末',
      deviceText,
      '',
      '■ 写真(' + photoRows.length + ' 枚)',
      tsv(['#', '選んだ道', 'オプション', '名前', 'type', '大きさ', 'lastModified', '形式', '撮影日時', 'EXIF の位置'], photoRows,
        ['no', 'route', 'option', 'name', 'type', 'size', 'lastModified', 'format', 'date', 'gps']),
      '',
      '■ 位置',
      '取り方の指定: ' + JSON.stringify(GEO_OPTIONS) + '・測る時間 ' + DURATION_S + ' 秒・表は ' + (TICK_MS / 1000) + ' 秒ごと',
      geoSummary.join('\n'),
      tsv(['秒', '時計の秒', '誤差の半径 m', 'この秒に取れたか', '値は何秒前', '止まった理由'], geoRows,
        ['n', 'clock', 'acc', 'got', 'age', 'reason'])
    ].join('\n');
  }

  function updateResult() { $('result-text').value = buildResult(); }

  function copyResult() {
    var text = buildResult();
    var area = $('result-text');
    area.value = text;
    function fallback() {
      area.focus();
      area.select();
      area.setSelectionRange(0, text.length);
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      $('copy-status').textContent = ok ? 'コピーしました。秘書の会話に貼ってください。' : 'コピーできませんでした。下の欄を長押しして全部を選び、コピーしてください。';
    }
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(function () {
        $('copy-status').textContent = 'コピーしました。秘書の会話に貼ってください。';
      }, fallback);
    } else {
      fallback();
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    $('geo-options').textContent = JSON.stringify(GEO_OPTIONS) + '・' + DURATION_S + ' 秒';
    showDevice();
    $('photos').addEventListener('change', onPhotos);
    $('geo-start').addEventListener('click', startGeo);
    $('copy').addEventListener('click', copyResult);
    updateResult();
  });
})();
