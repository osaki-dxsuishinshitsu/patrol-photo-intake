/*
 * 災防協パトロール 写真送信ページ
 * - 前半 = 検証と送る中身の組み立て(DOM に依存しない。node から検査できる)
 * - 後半 = 画面の動き(ブラウザのときだけ動く)
 * 送信は 1 回押すだけ: 入力と縮小した写真をこの端末に残してから、受付(Google Apps Script)へ送る。
 * 送れなかったものは端末に残し、電波が戻ったとき・ページを開き直したときに自動で送り直す(outbox.js)。
 * 通信先は config.js の endpoint(受付)だけ。受け口のメールアドレスはこのページに無い。
 */
(function (root) {
  'use strict';

  var CODE_RE = /^[A-Za-z0-9-]{1,32}$/;
  var DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  // 受付(GAS の web app)の URL の形。仮の URL(TEST- で始まる・PLACEHOLDER を含む)は通さない
  var ENDPOINT_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}\/exec$/;
  var PLACEHOLDER_RE = /\/s\/TEST-|PLACEHOLDER/i;
  // 値に入れさせない文字: 制御文字(改行を含む)と見えない書式の文字(受付と同じ)
  var BAD_CHAR_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/u;
  // 会社名・氏名に URL・メールアドレス・ドメインの形を入れさせない(全角は半角にそろえてから見る。受付と同じ)
  var LINK_RE = /:\/\/|www\.|@|xn--|\b\d{1,3}(\.\d{1,3}){3}\b|[a-z0-9-]\.(com|net|org|jp|ly|io|co|info|biz|me|dev|app|cloud|xyz|top|site|online|shop|link|click|page|to|cc|tk|ru|cn|us|uk)\b/i;
  // 氏名は、ドメインの形(英数字.英字 2 文字以上)を広く拒む(会社名は実在の社名と重なりうるので上の一覧だけ)
  var HOST_RE = /[a-z0-9-]+\.[a-z]{2,}/i;
  // 全角を半角にそろえ(NFKC)、ドメインの区切りに使われうる句点(。 ｡ ．)を . にそろえる(受付と同じ)
  function nfkc(v) {
    var s = String(v);
    return (s.normalize ? s.normalize('NFKC') : s).replace(/[\u3002\uff61\uff0e]/g, '.');
  }
  function looksLikeLink(v) {
    return LINK_RE.test(nfkc(v));
  }
  // ページと受付との取り決めの版(受付の PROTOCOL と同じ)
  var PROTOCOL = 1;
  // 1 通で選べる会社の上限(受付・受け側の流れと同じ)
  var MAX_COMPANIES = 20;
  // 立場が「その他」のときに入れる氏名の長さの上限
  var MAX_NAME = 30;
  // 書式 v2 の立場(受け側の流れの式 H と同じ)
  var ROLES_V2 = ['代表者', '安全衛生責任者', 'その他'];
  // 写真の縮小(長い辺の画素数と JPEG の品質)。紙の文字が読める大きさを残し、電波が弱くても送れる量にする
  var MAX_SIDE = 1600;
  var JPEG_QUALITY = 0.8;
  // 1 通に付ける写真の上限と、大きさの上限(受付と同じ。縮小した後の大きさ)
  var MAX_PHOTOS = 10;
  var MAX_PHOTO_BYTES = 1572864;  // 1 枚 1.5 MB
  var MAX_TOTAL_BYTES = 8388608;  // 合計 8 MB

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

  // 選ばれた実施者をその現場の一覧の並び順にそろえ、重複(同じ会社)と一覧外を落とす
  // member = { company, role, name }(name は立場が「その他」のときだけ使う)
  function normalizeMembers(config, siteCode, list) {
    var picked = list || [];
    var out = [];
    companiesForSite(config, siteCode).forEach(function (c) {
      for (var i = 0; i < picked.length; i++) {
        if (picked[i] && picked[i].company === c) {
          var role = picked[i].role || '';
          var name = role === config.otherRole ? String(picked[i].name || '').trim() : '';
          out.push({ company: c, role: role, name: name });
          return;
        }
      }
    });
    return out;
  }

  // 氏名(立場が「その他」のとき): 1〜30 文字、本文の区切り(; | =)・制御文字・見えない書式の文字・URL の形は不可、先頭の = + - @ も不可
  function isValidName(n) {
    return typeof n === 'string' && n.length >= 1 && n.length <= MAX_NAME &&
      !/[;|=\/]/.test(n) && !BAD_CHAR_RE.test(n) && !looksLikeLink(n) && !HOST_RE.test(nfkc(n)) && !/^[=+\-@]/.test(nfkc(n));
  }

  /*
   * state = { date, dept, site, members: [{ company, role, name }], photoCount }
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

    var members = normalizeMembers(config, s.site, s.members);
    if (members.length === 0) {
      errors.push({ field: 'companies', message: '実施した会社を 1 社以上選んでください' });
    } else if (members.length > MAX_COMPANIES) {
      errors.push({ field: 'companies', message: '会社は ' + MAX_COMPANIES + ' 社までにしてください' });
    }
    members.forEach(function (m) {
      if ((config.roles || []).indexOf(m.role) === -1) {
        errors.push({ field: 'roles', message: '「' + m.company + '」で実施した人の立場を選んでください' });
      } else if (m.role === config.otherRole && !m.name) {
        errors.push({ field: 'roles', message: '「' + m.company + '」で実施した人の氏名を入れてください' });
      } else if (m.role === config.otherRole && !isValidName(m.name)) {
        errors.push({ field: 'roles', message: '「' + m.company + '」の氏名は ' + MAX_NAME + ' 文字までで、; | = / @ と URL は使えません(先頭に + - も使えません)' });
      }
    });

    if (!(s.photoCount >= 1)) {
      errors.push({ field: 'photos', message: 'チェックシートの写真を 1 枚以上選んでください' });
    } else if (s.photoCount > MAX_PHOTOS) {
      errors.push({ field: 'photos', message: '写真は ' + MAX_PHOTOS + ' 枚までにしてください' });
    }

    return errors;
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

  // 乱数の 16 進(送信 1 回ごとの控え番号 = 4 バイト、端末の印 = 8 バイト)
  function randomHex(bytes) {
    var c = root.crypto;
    var b = new Uint8Array(bytes);
    if (c && c.getRandomValues) {
      c.getRandomValues(b);
    } else {
      for (var i = 0; i < bytes; i++) b[i] = Math.floor(Math.random() * 256);
    }
    var s = '';
    for (var j = 0; j < bytes; j++) s += (b[j] < 16 ? '0' : '') + b[j].toString(16);
    return s;
  }

  function newRef() {
    return randomHex(4);
  }

  // 写真の大きさ(base64 の文字数から元の大きさを出す)
  function base64Bytes(data) {
    var pad = /==$/.test(data) ? 2 : /=$/.test(data) ? 1 : 0;
    return data.length / 4 * 3 - pad;
  }

  // 用意した写真 [{ type, data }] が送れるか。送れないときは本人に見せる文
  function checkPhotos(photos) {
    if (!photos.length || photos.length > MAX_PHOTOS) return '写真は 1〜' + MAX_PHOTOS + ' 枚にしてください。';
    var total = 0;
    for (var i = 0; i < photos.length; i++) {
      var p = photos[i];
      if (p.type !== 'image/jpeg' && p.type !== 'image/png') return (i + 1) + ' 枚目の写真はこの端末で送れる形(JPEG)にできませんでした。カメラで撮り直すか、別の写真を選んでください。';
      var n = base64Bytes(p.data);
      if (n > MAX_PHOTO_BYTES) return (i + 1) + ' 枚目の写真が大きすぎます(1 枚 1.5 MB まで)。撮り直すか、別の写真を選んでください。';
      total += n;
    }
    if (total > MAX_TOTAL_BYTES) return '写真の合計が大きすぎます(8 MB まで)。枚数を減らしてください。';
    return null;
  }

  // 受付へ送る中身(仕様 D21 の JSON)。件名・本文・宛先は受付が決める
  function buildPayload(state, config, meta, photos, device) {
    return {
      p: PROTOCOL,
      formId: config.formId,
      formVersion: config.formVersion,
      ref: meta.ref,
      date: state.date,
      dept: state.dept,
      site: state.site,
      members: normalizeMembers(config, state.site, state.members).map(function (m) {
        return m.role === config.otherRole ? { company: m.company, role: m.role, name: m.name } : { company: m.company, role: m.role };
      }),
      created: meta.created,
      device: device,
      photos: photos.map(function (p) { return { type: p.type, data: p.data }; })
    };
  }

  // 時間切れまでの長さ: 60 秒 + 送る量(1 秒に約 16 KB)。最長 6 分(受付の 1 回の実行の上限に合わせた [推定]:
  // 送る時間が受付の実行時間に含まれるかは確かめていない。実機の確認 USER-STEP w で見直す)
  function timeoutMs(chars) {
    return Math.min(360000, 60000 + Math.ceil(chars / 16));
  }

  // 設定そのものの誤り(差し替え時の書き損じ)を画面に出す前に見つける
  function checkConfig(config) {
    var problems = [];
    if (!CODE_RE.test(config.formId || '')) problems.push('formId');
    if (!(config.formVersion >= 1)) problems.push('formVersion');
    if (!ENDPOINT_RE.test(config.endpoint || '') || PLACEHOLDER_RE.test(config.endpoint || '')) problems.push('endpoint');
    (config.sites || []).forEach(function (s) {
      if (!CODE_RE.test(s.code || '') || !CODE_RE.test(s.dept || '')) problems.push('sites:' + s.code);
    });
    (config.roster || []).forEach(function (r, i) {
      var c = r.company;
      // ; = 改行は本文の区切り、先頭の = + - @ は表計算で式と読まれるため使えない
      // 前後の空白も不可(受け側は空白を取ってマスタと照らすため、食い違いの元になる)。長さは受付と同じ 60 文字まで
      if (typeof c !== 'string' || !c || c.length > 60 || /[;|=]/.test(c) || BAD_CHAR_RE.test(c) || looksLikeLink(c) || /^[=+\-@]/.test(nfkc(c)) || c !== c.trim()) problems.push('roster[' + i + '].company');
      if (!findSite(config, r.site)) problems.push('roster[' + i + '].site');
      // 公開してよいのは現場コードと会社名だけ(ほかの項目が紛れ込んだら止める)
      if (Object.keys(r).some(function (k) { return k !== 'site' && k !== 'company'; })) problems.push('roster[' + i + '].keys');
    });
    if (!(config.roster || []).length) problems.push('roster');
    // 立場は本文の書式(版)の一部。受け側の流れと同じ 3 つ・同じ順でなければ止める(変えるときは版を上げる)
    if (JSON.stringify(config.roles) !== JSON.stringify(ROLES_V2) || config.otherRole !== ROLES_V2[2]) problems.push('roles');
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
    normalizeMembers: normalizeMembers,
    isValidName: isValidName,
    validate: validate,
    isoWithOffset: isoWithOffset,
    newRef: newRef,
    randomHex: randomHex,
    checkPhotos: checkPhotos,
    buildPayload: buildPayload,
    timeoutMs: timeoutMs,
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
  var O = root.PatrolOutbox;

  var state = { date: '', dept: '', site: '', members: [], photoCount: 0 };
  var photos = [];     // { file, url }
  var meta = null;     // 確認画面に入った時点で作る { ref, created }
  var ready = null;    // 送る形にした写真 [{ type, data }](確認画面で用意する)
  var prepToken = 0;   // 古い準備の結果を捨てるための番号
  var outbox = null;
  var storageOk = false;
  var currentRef = null; // 完了画面で見せている送信

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

  // 端末の印(送信の回数の上限に使う。本人の証明ではない)。残せない端末では開くたびに作る
  function deviceId() {
    var key = 'patrol-device';
    try {
      var v = root.localStorage.getItem(key);
      if (/^[0-9a-f]{16}$/.test(v || '')) return v;
      v = randomHex(8);
      root.localStorage.setItem(key, v);
      return v;
    } catch (e) {
      return randomHex(8);
    }
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

  // 作り直した後も、操作していた欄にフォーカスを戻す
  function refocus(id) {
    var f = $(id);
    if (f) f.focus();
  }

  function findMember(company) {
    for (var i = 0; i < state.members.length; i++) {
      if (state.members[i].company === company) return state.members[i];
    }
    return null;
  }

  // 選んだ現場の会社だけを出す。現場を変えたら、その現場に無い会社の選択は外す。
  // 会社を選ぶと、その会社で実施した人の立場を選ぶ欄が開く(「その他」のときだけ氏名の欄)
  function renderCompanies() {
    var box = $('company-list');
    state.members = normalizeMembers(config, state.site, state.members);
    box.textContent = '';
    $('company-empty').hidden = !!state.site;
    companiesForSite(config, state.site).forEach(function (c, i) {
      var member = findMember(c);
      var wrap = el('div', { 'class': 'member' });
      var id = 'company-' + i;
      var label = el('label', { 'for': id, 'class': 'check' });
      var input = el('input', { type: 'checkbox', id: id, value: c });
      input.checked = !!member;
      input.addEventListener('change', function () {
        if (input.checked) {
          state.members.push({ company: c, role: '', name: '' });
        } else {
          state.members = state.members.filter(function (m) { return m.company !== c; });
        }
        renderCompanies();
        refresh();
        refocus(id);
      });
      label.appendChild(input);
      label.appendChild(el('span', null, c));
      wrap.appendChild(label);

      if (member) {
        var group = el('fieldset', { 'class': 'roles' });
        group.appendChild(el('legend', null, c + ' で実施した人の立場'));
        config.roles.forEach(function (r, j) {
          var rid = id + '-role-' + j;
          var rl = el('label', { 'for': rid, 'class': 'check' });
          var radio = el('input', { type: 'radio', id: rid, name: id + '-role', value: r });
          radio.checked = member.role === r;
          radio.addEventListener('change', function () {
            member.role = r;
            renderCompanies();
            refresh();
            refocus(rid);
          });
          rl.appendChild(radio);
          rl.appendChild(el('span', null, r));
          group.appendChild(rl);
        });
        if (member.role === config.otherRole) {
          var nid = id + '-name';
          group.appendChild(el('label', { 'for': nid, 'class': 'name-label' }, '氏名'));
          var nameInput = el('input', { type: 'text', id: nid, maxlength: String(MAX_NAME), autocomplete: 'name' });
          nameInput.value = member.name || '';
          nameInput.addEventListener('input', function () {
            member.name = nameInput.value;
            refresh();
          });
          group.appendChild(nameInput);
          group.appendChild(el('p', { 'class': 'hint' }, '氏名はパトロールの実施記録として社内でだけ使います。送り終えるまではこの端末に残り、送り終えたら消えます(「送れません」となった記録は、下の「送信の記録」から消すまで残ります)。'));
        }
        wrap.appendChild(group);
      }
      box.appendChild(wrap);
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

  function membersText(members) {
    return members.map(function (m) {
      return m.company + '(' + m.role + (m.role === config.otherRole ? ': ' + m.name : '') + ')';
    }).join('、');
  }

  function renderConfirm() {
    $('c-date').textContent = state.date;
    $('c-dept').textContent = state.dept;
    $('c-site').textContent = state.site;
    $('c-companies').textContent = membersText(normalizeMembers(config, state.site, state.members));
    $('c-photos').textContent = state.photoCount + ' 枚';
    var list = $('c-photo-list');
    list.textContent = '';
    photos.forEach(function (p, i) {
      var li = el('li', { 'class': 'photo' });
      li.appendChild(el('img', { src: p.url, alt: 'チェックシートの写真 ' + (i + 1) }));
      list.appendChild(li);
    });
  }

  /* ---- 写真を送る形にする(縮小して base64)---- */

  // 写真を長い辺 MAX_SIDE px の JPEG に縮小する(画像の位置情報などは付かない)。
  // できない端末・失敗・時間切れのときは元の写真のまま。使い終わった画像と canvas はすぐ手放す
  function shrinkPhoto(file) {
    return new Promise(function (resolve) {
      var canvas = doc.createElement('canvas');
      var ctx = canvas.getContext ? canvas.getContext('2d') : null;
      if (!ctx || !canvas.toBlob) { resolve(file); return; }
      var url = root.URL.createObjectURL(file);
      var img = new root.Image();
      var done = false;
      var timer = null;
      function finish(f) {
        if (done) return;
        done = true;
        root.clearTimeout(timer);
        img.onload = img.onerror = null;
        img.removeAttribute('src');
        canvas.width = canvas.height = 0;
        root.URL.revokeObjectURL(url);
        resolve(f);
      }
      timer = root.setTimeout(function () { finish(file); }, 15000);
      img.onload = function () {
        try {
          var s = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
          canvas.width = Math.round(img.naturalWidth * s);
          canvas.height = Math.round(img.naturalHeight * s);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(function (blob) { finish(blob || file); }, 'image/jpeg', JPEG_QUALITY);
        } catch (e) {
          finish(file);
        }
      };
      img.onerror = function () { finish(file); };
      img.src = url;
    });
  }

  // Blob → { type, data(base64) }
  function toBase64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new root.FileReader();
      r.onload = function () {
        var s = String(r.result || '');
        resolve({ type: blob.type, data: s.slice(s.indexOf(',') + 1) });
      };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(blob);
    });
  }

  // 確認画面に入ったら、送る写真を先に用意する。メモリを使い過ぎないよう 1 枚ずつ
  function preparePhotos() {
    var token = ++prepToken;
    ready = null;
    var btn = $('send');
    btn.disabled = true;
    btn.textContent = '写真を準備しています…';
    $('prep-error').hidden = true;
    var out = [];
    var chain = Promise.resolve();
    photos.forEach(function (p) {
      chain = chain.then(function () {
        if (token !== prepToken) return;
        return shrinkPhoto(p.file).then(toBase64).then(function (x) { out.push(x); });
      });
    });
    chain.then(function () {
      if (token !== prepToken) return;
      var why = checkPhotos(out);
      if (why) throw new Error(why);
      ready = out;
      btn.disabled = false;
      btn.textContent = '送信する';
    }).catch(function (e) {
      if (token !== prepToken) return;
      btn.textContent = '送信できません';
      $('prep-error').hidden = false;
      $('prep-error').textContent = (e && e.message && /枚目|写真/.test(e.message)) ? e.message : '写真を準備できませんでした。写真を選び直してください。';
    });
  }

  /* ---- 送信と、送れていないものの表示 ---- */

  function postToIntake(payload) {
    var body = JSON.stringify(payload);
    var ctrl = typeof root.AbortController === 'function' ? new root.AbortController() : null;
    var timedOut = false;
    var timer = root.setTimeout(function () { timedOut = true; if (ctrl) ctrl.abort(); }, timeoutMs(body.length));
    return root.fetch(config.endpoint, {
      method: 'POST',
      // text/plain にすると事前の問い合わせ(preflight)なしで送れる(受付はそれに答えられないため)
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: body,
      redirect: 'follow',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) {
      return r.text();
    }).then(function (t) {
      try { return JSON.parse(t); } catch (e) { return { network: true, code: 'bad_response' }; }
    }, function () {
      return { network: true, code: timedOut ? 'timeout' : 'network' };
    }).then(function (res) {
      root.clearTimeout(timer);
      return res;
    });
  }

  function recordLine(r) {
    var s = r.summary || {};
    return s.date + ' 現場 ' + s.site + '・会社 ' + s.companies + ' 社・写真 ' + s.photos + ' 枚';
  }

  function renderOutbox() {
    if (!outbox) return;
    var st = outbox.status();
    var bar = $('outbox-bar');
    var msgs = [];
    if (st.pending) msgs.push('送れていないものが ' + st.pending + ' 件あります。電波のある所でこのページを開いていれば、自動で送ります。');
    if (st.blocked) msgs.push('送れないものが ' + st.blocked + ' 件あります。下の「送信の記録」で理由を見てください。');
    if (st.unsaved) msgs.push('この端末に残せなかった送信があります。このページを閉じると、送れていない分は消えます。電波のある所で送り終えるまで、ページを閉じないでください。');
    bar.hidden = msgs.length === 0;
    bar.textContent = msgs.join(' ');
    bar.className = 'outbox-bar' + (st.blocked || st.unsaved ? ' bad' : '');

    var list = outbox.list();
    $('outbox').hidden = list.length === 0;
    var ul = $('outbox-list');
    ul.textContent = '';
    list.forEach(function (r) {
      var li = el('li', { 'class': 'rec rec-' + r.state });
      var head = r.state === 'sent' ? '送信済み 受付番号 ' + r.receipt
        : r.state === 'blocked' ? '送れません'
        : (r.sending ? '送信中…' : '送れていません(自動で送り直します)');
      li.appendChild(el('p', { 'class': 'rec-head' }, head));
      li.appendChild(el('p', { 'class': 'hint' }, recordLine(r)));
      if (r.state !== 'sent' && r.lastCode) {
        var d = O.describe(r.lastCode, r.state);
        li.appendChild(el('p', { 'class': r.state === 'blocked' ? 'error' : 'hint' }, d.what + ' ' + d.fix));
      }
      // 受付の設定の遅れで「送れません」になった記録だけ、本人がもう一度送れる(判定は outbox.canRetry)
      if (outbox.canRetry(r.id)) {
        var again = el('button', { type: 'button' }, 'もう一度送る');
        again.addEventListener('click', function () {
          again.disabled = true;
          // 中身はそのまま送り直す(版を当てない)
          outbox.retry(r.id).then(function () {
            return auto.run(true, r.id);
          }).then(null, function () { again.disabled = false; });
        });
        li.appendChild(again);
      }
      // 受付の設定の遅れで自動の送り直しを待っている記録は、待ちを飛ばして今すぐ送れる(判定は outbox.canSendNow)
      if (outbox.canSendNow(r.id)) {
        var now1 = el('button', { type: 'button' }, '今すぐ送る');
        now1.addEventListener('click', function () {
          now1.disabled = true;
          outbox.sendNow(r.id).then(function () {
            return auto.run(true, r.id);
          }).then(null, function () { now1.disabled = false; });
        });
        li.appendChild(now1);
      }
      if (r.state === 'blocked') {
        // 「もう一度送る」が出ている記録は、受付が直れば送れる(端末にしか中身が無い)。消す前にそれを伝える
        var retryable = outbox.canRetry(r.id);
        var rm = el('button', { type: 'button' }, 'この記録を消す');
        var armed = false;
        rm.addEventListener('click', function () {
          if (!armed) {
            armed = true;
            rm.textContent = retryable
              ? 'この記録は受付が直れば送れます。消すと、もう送れません。先に「もう一度送る」を押してください。それでも消すなら、もう一度押す'
              : 'もう一度押すと消します(元に戻せません)';
            return;
          }
          outbox.remove(r.id).then(function (ok) {
            if (!ok) {
              rm.textContent = '消せませんでした。もう一度押してください';
              armed = false;
            }
          });
        });
        li.appendChild(rm);
      }
      ul.appendChild(li);
    });
    renderCurrent();
  }

  // 完了画面: いま送った 1 件の状態
  function renderCurrent() {
    if (!currentRef || $('step-done').hidden) return;
    var r = outbox.get(currentRef);
    var box = $('d-status');
    var fix = $('d-fix');
    fix.hidden = true;
    // 「端末に残せなかった」の赤い表示は、この送信がまだ送れていない間だけ出す
    var unsavedHere = !!r && outbox.isUnsaved(r.id);
    $('d-storage').hidden = !unsavedHere;
    if (!r) {
      box.textContent = '送信の記録が見つかりません。';
      box.className = 'status bad';
      return;
    }
    if (r.state === 'sent') {
      box.textContent = '送信済み。受付番号 ' + r.receipt;
      box.className = 'status ok';
      $('h-done').textContent = '3. 受け付けました';
    } else if (r.state === 'blocked') {
      var d = O.describe(r.lastCode, r.state);
      box.textContent = '送れません: ' + d.what;
      box.className = 'status bad';
      fix.hidden = false;
      fix.textContent = d.fix;
      $('h-done').textContent = '3. 送れませんでした';
    } else {
      var kept = unsavedHere ? 'この端末には残せていません。送り終えるまでページを閉じないでください。' : 'この端末に残してあります。';
      box.textContent = r.sending ? '送信中です…'
        : !r.lastCode ? '送信の順番を待っています(前の送信の後に送ります)。' + kept
        : 'まだ送れていません。' + kept + '送れる状態になると自動で送ります。';
      box.className = 'status wait';
      if (!r.sending && r.lastCode) {
        fix.hidden = false;
        fix.textContent = O.describe(r.lastCode, r.state).what;
      }
      $('h-done').textContent = '3. 送信';
    }
  }

  function send() {
    if (validate(state, config).length) {
      show('step-input');
      refresh();
      return;
    }
    if (!ready || !meta) return;
    var btn = $('send');
    if (!outbox) {
      $('prep-error').hidden = false;
      $('prep-error').textContent = '送信の準備中です。数秒待ってから、もう一度押してください。';
      return;
    }
    btn.disabled = true;
    btn.textContent = 'この端末に保存しています…';
    $('back').disabled = true; // 保存の途中で入力の画面に戻らない
    var members = normalizeMembers(config, state.site, state.members);
    var rec = {
      id: meta.ref,
      createdAt: Date.now(),
      summary: { date: state.date, site: state.site, companies: members.length, photos: ready.length },
      payload: buildPayload(state, config, meta, ready, deviceId())
    };
    outbox.add(rec).then(function (r) {
      if (r.error) {
        var d = O.describe(r.error);
        $('prep-error').hidden = false;
        $('prep-error').textContent = d.what + ' ' + d.fix;
        btn.disabled = false;
        btn.textContent = '送信する';
        $('back').disabled = false;
        return;
      }
      currentRef = rec.id;
      $('back').disabled = false;
      $('d-storage').hidden = r.saved;
      show('step-done');
      renderOutbox();
      auto.run(true, rec.id);
    }).catch(function () {
      $('prep-error').hidden = false;
      $('prep-error').textContent = '送信できませんでした。もう一度「送信する」を押してください。';
      btn.disabled = false;
      btn.textContent = '送信する';
      $('back').disabled = false;
    });
  }

  var auto = { run: function () { return Promise.resolve(); } };

  function startOutbox() {
    function begin(store) {
      storageOk = !!store;
      outbox = O.createOutbox({ store: store, send: postToIntake, onChange: renderOutbox });
      auto = O.startAutoRetry({ win: root, doc: doc, outbox: outbox });
      $('storage-warning').hidden = storageOk;
      return loadStored().then(function () {
        return auto.run(true);
      });
    }
    // 端末に残した記録を読み込む。読めなかったら 1 回だけ読み直し、それでもだめなら赤く知らせる
    function loadStored() {
      return outbox.load().then(renderOutbox, function () {
        return new Promise(function (r) { root.setTimeout(r, 2000); }).then(function () { return outbox.load(); }).then(renderOutbox, function () {
          $('storage-warning').hidden = false;
          $('storage-warning').textContent = LOAD_FAILED_TEXT;
        });
      });
    }
    // 端末に残したものが消されにくくなるよう頼む(許されるかは端末が決める)
    try {
      if (root.navigator.storage && root.navigator.storage.persist) root.navigator.storage.persist().then(null, function () {});
    } catch (e) { /* 無視 */ }
    // 保存先が 3 秒で開かない端末では、残せないものとして始める(送信の操作を止めない)。
    // 後から開いたら、その保存先をつなぐ(画面に出ている記録を保存し、前に残した記録も読み込む)
    var started = false;
    function once(store) {
      if (started) {
        if (store && outbox && !storageOk) {
          storageOk = true;
          return outbox.attachStore(store).then(function () {
            $('storage-warning').hidden = true;
            $('d-storage').hidden = outbox.status().unsaved === 0;
            renderOutbox();
            return auto.run(true);
          }, function () {
            // 保存先はつないだが、前に残した記録を読めなかった
            $('d-storage').hidden = outbox.status().unsaved === 0;
            $('storage-warning').hidden = false;
            $('storage-warning').textContent = LOAD_FAILED_TEXT;
            renderOutbox();
            return auto.run(true);
          });
        }
        return null;
      }
      started = true;
      return begin(store);
    }
    root.setTimeout(function () { once(null); }, 3000);
    return O.createIdbStore(root.indexedDB).then(once, function () { return once(null); });
  }

  var LOAD_FAILED_TEXT = 'この端末に残した送信を読み込めませんでした。送れていないものがあるかもしれません。このページを開き直してください。続くときは、配られた説明の紙の連絡先へ。';

  // 入力だけを最初に戻す(ページを読み直さない = 送っている途中の送信や、端末に残せなかった送信を消さない)
  function resetForm() {
    prepToken++;
    photos.forEach(function (p) { root.URL.revokeObjectURL(p.url); });
    photos = [];
    ready = null;
    meta = null;
    currentRef = null;
    state.date = '';
    state.members = [];
    $('date').value = '';
    $('date').max = todayLocal(); // 日付が変わっていたら、今日を選べるように
    $('prep-error').hidden = true;
    $('photo-over').hidden = true;
    var btn = $('send');
    btn.disabled = true;
    btn.textContent = '写真を準備しています…';
    renderCompanies();
    renderPhotos();
    refresh();
    show('step-input');
  }

  // LINE などのアプリの中のブラウザは、送れなかったものの置き場が普段のブラウザと別で、閉じると消えることがある
  function inAppBrowser() {
    return / Line\/|FBAN|FBAV|Instagram/i.test(root.navigator.userAgent || '');
  }

  function init() {
    var problems = checkConfig(config);
    if (!O) problems.push('outbox.js');
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
      preparePhotos();
    });
    $('back').addEventListener('click', function () {
      prepToken++; // 写真の準備を途中でやめる
      ready = null;
      show('step-input');
    });
    $('send').addEventListener('click', send);
    $('restart').addEventListener('click', resetForm);
    // 端末に残せなかった送信がある間は、閉じる・読み直す前にブラウザの確認を出す
    root.addEventListener('beforeunload', function (e) {
      if (outbox && (outbox.status().unsaved > 0)) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    renderPhotos();
    refresh();
    $('inapp-warning').hidden = !inAppBrowser();
    startOutbox();
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : globalThis);
