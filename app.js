/*
 * 災防協パトロール 写真送信ページ
 * - 前半 = 検証と件名・本文の生成(DOM に依存しない。node から検査できる)
 * - 後半 = 画面の動き(ブラウザのときだけ動く)
 * ページは外部へ通信しない。写真はこの端末の中で表示するだけで、どこにも送らない。
 */
(function (root) {
  'use strict';

  var CODE_RE = /^[A-Za-z0-9-]{1,32}$/;
  var DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  // 受け口のアドレス。? & # = % を含むと mailto に宛先や項目が足されうるため、英数字と . _ - だけ
  var MAILBOX_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
  // 1 通で選べる会社の上限(受け側の流れと同じ)
  var MAX_COMPANIES = 20;
  // 1 通に付ける写真の上限(大きなメールは届かないことがあるため)
  var MAX_PHOTOS = 10;

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  // 端末の現地時刻での今日 = 'YYYY-MM-DD'
  function todayLocal(now) {
    var d = now || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  // 暦の上で実在する日付か(2026-02-30 などを弾く)
  function isRealDate(s) {
    var m = DATE_RE.exec(s || '');
    if (!m) return false;
    var y = +m[1], mo = +m[2], d = +m[3];
    var dt = new Date(y, mo - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
  }

  function findSite(config, code) {
    for (var i = 0; i < config.sites.length; i++) {
      if (config.sites[i].code === code) return config.sites[i];
    }
    return null;
  }

  // その現場の会社名(roster の並び順・重複なし)
  function companiesForSite(config, siteCode) {
    var out = [];
    (config.roster || []).forEach(function (r) {
      if (r.site === siteCode && out.indexOf(r.company) === -1) out.push(r.company);
    });
    return out;
  }

  // 選ばれた会社をその現場の一覧の並び順にそろえ、重複と一覧外を落とす
  function normalizeCompanies(config, siteCode, list) {
    var picked = list || [];
    return companiesForSite(config, siteCode).filter(function (c) {
      return picked.indexOf(c) !== -1;
    });
  }

  /*
   * state = { date, dept, site, companies: [], photoCount }
   * 戻り値 = 欠けている・誤っている項目の一覧。空なら確認へ進める。
   */
  function validate(state, config, now) {
    var errors = [];
    var s = state || {};

    if (!s.date) {
      errors.push({ field: 'date', message: '実施日を選んでください' });
    } else if (!isRealDate(s.date)) {
      errors.push({ field: 'date', message: '実施日の形が正しくありません' });
    } else if (s.date > todayLocal(now)) {
      errors.push({ field: 'date', message: '実施日に未来の日は選べません' });
    }

    var site = s.site ? findSite(config, s.site) : null;
    if (!s.site) {
      errors.push({ field: 'site', message: '現場を選んでください' });
    } else if (!site) {
      errors.push({ field: 'site', message: '現場のコードが一覧にありません' });
    }

    if (!s.dept) {
      errors.push({ field: 'dept', message: '部署が決まっていません(現場を選び直してください)' });
    } else if (site && site.dept !== s.dept) {
      errors.push({ field: 'dept', message: '部署と現場の組み合わせが一覧と違います' });
    }

    var companies = normalizeCompanies(config, s.site, s.companies);
    if (companies.length === 0) {
      errors.push({ field: 'companies', message: '実施した会社を 1 社以上選んでください' });
    } else if (companies.length > MAX_COMPANIES) {
      errors.push({ field: 'companies', message: '会社は ' + MAX_COMPANIES + ' 社までにしてください' });
    }

    if (!(s.photoCount >= 1)) {
      errors.push({ field: 'photos', message: 'チェックシートの写真を 1 枚以上選んでください' });
    } else if (s.photoCount > MAX_PHOTOS) {
      errors.push({ field: 'photos', message: '写真は ' + MAX_PHOTOS + ' 枚までにしてください' });
    }

    return errors;
  }

  function buildSubject(state, config) {
    return '[' + config.formId + '/' + config.formVersion + '] ' + state.date + ' ' + state.site;
  }

  function beginMarker(config) {
    return '---BEGIN ' + config.formId + '/' + config.formVersion + '---';
  }

  function endMarker(config) {
    return '---END ' + config.formId + '/' + config.formVersion + '---';
  }

  // ISO-8601 + 端末の時差(例 2026-09-29T10:15:00+09:00)
  function isoWithOffset(d) {
    var off = -d.getTimezoneOffset();
    var sign = off >= 0 ? '+' : '-';
    var a = Math.abs(off);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) +
      sign + pad2(Math.floor(a / 60)) + ':' + pad2(a % 60);
  }

  // 送信 1 回ごとの控え番号(8 桁の 16 進)
  function newRef() {
    var c = root.crypto;
    var b = new Uint8Array(4);
    if (c && c.getRandomValues) {
      c.getRandomValues(b);
    } else {
      for (var i = 0; i < 4; i++) b[i] = Math.floor(Math.random() * 256);
    }
    var s = '';
    for (var j = 0; j < 4; j++) s += (b[j] < 16 ? '0' : '') + b[j].toString(16);
    return s;
  }

  // 本文。機械が読むのは BEGIN 行と END 行の間だけ(振り分け規約)
  function buildBody(state, config, meta) {
    var companies = normalizeCompanies(config, state.site, state.companies);
    var lines = [
      'このメールに、ページで選んだチェックシートの写真(' + state.photoCount + ' 枚)を添付してから送信してください。',
      '下の --- で囲んだ部分は書き換えないでください。',
      '',
      beginMarker(config),
      'ref=' + meta.ref,
      'date=' + state.date,
      'dept=' + state.dept,
      'site=' + state.site,
      'companies=' + companies.join(';'),
      'photos=' + state.photoCount,
      'created=' + meta.created,
      endMarker(config)
    ];
    return lines.join('\r\n');
  }

  function buildMailto(state, config, meta) {
    return 'mailto:' + config.mailbox +
      '?subject=' + encodeURIComponent(buildSubject(state, config)) +
      '&body=' + encodeURIComponent(buildBody(state, config, meta));
  }

  // 設定そのものの誤り(差し替え時の書き損じ)を画面に出す前に見つける
  function checkConfig(config) {
    var problems = [];
    if (!CODE_RE.test(config.formId || '')) problems.push('formId');
    if (!(config.formVersion >= 1)) problems.push('formVersion');
    if (!MAILBOX_RE.test(config.mailbox || '')) problems.push('mailbox');
    (config.sites || []).forEach(function (s) {
      if (!CODE_RE.test(s.code || '') || !CODE_RE.test(s.dept || '')) problems.push('sites:' + s.code);
    });
    (config.roster || []).forEach(function (r, i) {
      var c = r.company;
      // ; = 改行は本文の区切り、先頭の = + - @ は表計算で式と読まれるため使えない
      // 前後の空白も不可(受け側は空白を取ってマスタと照らすため、食い違いの元になる)
      if (typeof c !== 'string' || !c || /[;\r\n=]/.test(c) || /^[=+\-@]/.test(c) || c !== c.trim()) problems.push('roster[' + i + '].company');
      if (!findSite(config, r.site)) problems.push('roster[' + i + '].site');
      // 公開してよいのは現場コードと会社名だけ(ほかの項目が紛れ込んだら止める)
      if (Object.keys(r).some(function (k) { return k !== 'site' && k !== 'company'; })) problems.push('roster[' + i + '].keys');
    });
    if (!(config.roster || []).length) problems.push('roster');
    // どの現場にも会社が 1 社以上あること(無いと選べずに止まる)
    (config.sites || []).forEach(function (s) {
      if (!companiesForSite(config, s.code).length) problems.push('roster:' + s.code);
    });
    return problems;
  }

  var Core = {
    todayLocal: todayLocal,
    isRealDate: isRealDate,
    findSite: findSite,
    companiesForSite: companiesForSite,
    normalizeCompanies: normalizeCompanies,
    validate: validate,
    buildSubject: buildSubject,
    buildBody: buildBody,
    buildMailto: buildMailto,
    isoWithOffset: isoWithOffset,
    newRef: newRef,
    checkConfig: checkConfig
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Core;
    return;
  }

  /* ---------------- ここから画面の動き(ブラウザのみ) ---------------- */

  var doc = root.document;
  var config = root.PATROL_CONFIG || { sites: [] };
  config.roster = root.PATROL_ROSTER || [];

  var state = { date: '', dept: '', site: '', companies: [], photoCount: 0 };
  var photos = []; // { file, url }
  var meta = null; // 確認画面に入った時点で作る { ref, created }

  function $(id) {
    return doc.getElementById(id);
  }

  function el(tag, attrs, text) {
    var e = doc.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      e.setAttribute(k, attrs[k]);
    });
    if (text != null) e.textContent = text;
    return e;
  }

  function show(id) {
    ['step-input', 'step-confirm', 'step-done'].forEach(function (s) {
      $(s).hidden = (s !== id);
    });
    root.scrollTo(0, 0);
  }

  function setSite(code) {
    var site = findSite(config, code);
    state.site = site ? site.code : '';
    state.dept = site ? site.dept : '';
    $('site-fixed-code').textContent = site ? site.code : '';
    $('site-fixed-dept').textContent = site ? site.dept : '';
  }

  function renderSiteChoice() {
    var sel = $('site-select');
    sel.appendChild(el('option', { value: '' }, '選んでください'));
    config.sites.forEach(function (s) {
      sel.appendChild(el('option', { value: s.code }, s.code + '(部署 ' + s.dept + ')'));
    });
    sel.addEventListener('change', function () {
      setSite(sel.value);
      renderCompanies();
      refresh();
    });

    var param = new URLSearchParams(root.location.search).get('s');
    if (param && findSite(config, param)) {
      setSite(param);
      sel.value = param;
      $('site-fixed').hidden = false;
      $('site-choose').hidden = true;
    } else {
      $('site-fixed').hidden = true;
      $('site-choose').hidden = false;
    }
    $('site-change').addEventListener('click', function () {
      $('site-fixed').hidden = true;
      $('site-choose').hidden = false;
      sel.focus();
    });
  }

  // 選んだ現場の会社だけを出す。現場を変えたら、その現場に無い会社の選択は外す
  function renderCompanies() {
    var box = $('company-list');
    state.companies = normalizeCompanies(config, state.site, state.companies);
    box.textContent = '';
    $('company-empty').hidden = !!state.site;
    companiesForSite(config, state.site).forEach(function (c, i) {
      var id = 'company-' + i;
      var label = el('label', { 'for': id, 'class': 'check' });
      var input = el('input', { type: 'checkbox', id: id, value: c });
      input.checked = state.companies.indexOf(c) !== -1;
      input.addEventListener('change', function () {
        var picked = [];
        box.querySelectorAll('input[type=checkbox]').forEach(function (x) {
          if (x.checked) picked.push(x.value);
        });
        state.companies = picked;
        refresh();
      });
      label.appendChild(input);
      label.appendChild(el('span', null, c));
      box.appendChild(label);
    });
  }

  function renderPhotos() {
    var list = $('photo-list');
    list.textContent = '';
    photos.forEach(function (p, i) {
      var li = el('li', { 'class': 'photo' });
      li.appendChild(el('img', { src: p.url, alt: 'チェックシートの写真 ' + (i + 1) }));
      var rm = el('button', { type: 'button', 'class': 'link' }, 'この写真を外す');
      rm.addEventListener('click', function () {
        root.URL.revokeObjectURL(p.url);
        photos.splice(i, 1);
        renderPhotos();
        refresh();
      });
      li.appendChild(rm);
      list.appendChild(li);
    });
    state.photoCount = photos.length;
    $('photo-count').textContent = photos.length ? '選んだ写真: ' + photos.length + ' 枚' : 'まだ選んでいません';
  }

  function refresh() {
    var errors = validate(state, config);
    var ul = $('missing');
    ul.textContent = '';
    errors.forEach(function (e) {
      ul.appendChild(el('li', null, e.message));
    });
    $('missing-box').hidden = errors.length === 0;
    $('to-confirm').disabled = errors.length > 0;
    return errors;
  }

  function renderConfirm() {
    $('c-date').textContent = state.date;
    $('c-dept').textContent = state.dept;
    $('c-site').textContent = state.site;
    $('c-companies').textContent = normalizeCompanies(config, state.site, state.companies).join('、');
    $('c-photos').textContent = state.photoCount + ' 枚';
    $('c-mailbox').textContent = config.mailbox;
    $('c-subject').textContent = buildSubject(state, config);
    var list = $('c-photo-list');
    list.textContent = '';
    photos.forEach(function (p, i) {
      var li = el('li', { 'class': 'photo' });
      li.appendChild(el('img', { src: p.url, alt: 'チェックシートの写真 ' + (i + 1) }));
      list.appendChild(li);
    });
  }

  // 端末の中でのコピーだけ(外部への通信はしない)。使えない端末では文字を選択状態にする
  function copyText(node) {
    var text = node.textContent;
    var status = $('copy-status');
    function selectIt() {
      var range = doc.createRange();
      range.selectNodeContents(node);
      var sel = root.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      status.textContent = '文字を選びました。長押しで「コピー」を選んでください。';
    }
    if (root.navigator.clipboard && root.navigator.clipboard.writeText) {
      root.navigator.clipboard.writeText(text).then(function () {
        status.textContent = 'コピーしました。';
      }, selectIt);
    } else {
      selectIt();
    }
  }

  function openMail() {
    root.location.href = buildMailto(state, config, meta);
  }

  function init() {
    var problems = checkConfig(config);
    if (problems.length) {
      $('config-error').hidden = false;
      $('config-error').textContent = '設定に誤りがあります(' + problems.join(', ') + ')。担当に連絡してください。';
      return;
    }

    var dateInput = $('date');
    dateInput.max = todayLocal();
    // iPhone の Safari は日付の選択を閉じたときに change だけを出すことがあるため両方で受ける
    ['input', 'change'].forEach(function (ev) {
      dateInput.addEventListener(ev, function () {
        state.date = dateInput.value;
        refresh();
      });
    });

    renderSiteChoice();
    renderCompanies();

    var photoInput = $('photos');
    photoInput.addEventListener('change', function () {
      var over = 0;
      Array.prototype.forEach.call(photoInput.files || [], function (f) {
        if (f.type && f.type.indexOf('image/') !== 0) return;
        // 上限を超えた分は読み込まない(大量の写真で画面が重くならないように)
        if (photos.length >= MAX_PHOTOS) { over++; return; }
        photos.push({ file: f, url: root.URL.createObjectURL(f) });
      });
      photoInput.value = '';
      $('photo-over').hidden = over === 0;
      $('photo-over').textContent = over ? '写真は ' + MAX_PHOTOS + ' 枚までです。' + over + ' 枚は入れませんでした。' : '';
      renderPhotos();
      refresh();
    });

    $('to-confirm').addEventListener('click', function () {
      if (refresh().length) return;
      meta = { ref: newRef(), created: isoWithOffset(new Date()) };
      renderConfirm();
      show('step-confirm');
    });
    $('back').addEventListener('click', function () {
      show('step-input');
    });
    $('make-mail').addEventListener('click', function () {
      if (validate(state, config).length) {
        show('step-input');
        refresh();
        return;
      }
      $('d-photos').textContent = String(state.photoCount);
      $('x-to').textContent = config.mailbox;
      $('x-subject').textContent = buildSubject(state, config);
      $('x-body').textContent = buildBody(state, config, meta);
      show('step-done');
      openMail();
    });
    $('reopen-mail').addEventListener('click', openMail);
    Array.prototype.forEach.call(doc.querySelectorAll('.copy-btn'), function (btn) {
      btn.addEventListener('click', function () {
        copyText($(btn.getAttribute('data-copy')));
      });
    });
    $('restart').addEventListener('click', function () {
      root.location.reload();
    });

    renderPhotos();
    refresh();
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : globalThis);
