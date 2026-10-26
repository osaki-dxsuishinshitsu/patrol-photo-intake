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
  // このページが作る本文の書式の版(写真ごとのコメント = v3。仕様 D63)。書式を作るこのコードが版を持つ。
  // config.js の formVersion(2)は変えない: Pages のキャッシュで古い app.js が新しい config.js を読んでも、
  // 古い app.js はコメントの無い v2 を送り続けられるように(仕様 D64)
  var FORM_VERSION = 3;
  // 写真ごとのコメントの長さの上限(前後の空白を除いたコードポイントの数。受付と同じ。仕様 D61)
  var MAX_COMMENT = 100;
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
  // PDF は縮小せずそのまま送る。1 件 5 MB まで(写真の上限とは別。合計と件数は写真と同じ数え方。仕様 D126)
  var PDF_TYPE = 'application/pdf';
  var MAX_PDF_BYTES = 5242880;
  // 20 KB 以下は送れない(受け側の流れの式 E が 20 KB 以下を数えないため。送った人に「受け付けました」と出たまま行ができないのを避ける。仕様 D133)
  var MIN_PDF_BYTES = 20480;
  var PDF_B64_HEAD = 'JVBERi0';  // %PDF- の base64

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

  // 会社を選ぶ欄に出す会社(自社の行は出さない。自社は「自分が実施」でだけ使う。仕様 D52)
  function visibleCompanies(config, siteCode) {
    return companiesForSite(config, siteCode).filter(function (c) { return c !== config.ownCompany; });
  }

  // 協力会社の紙で選べる現場か(自社以外の会社が 1 社以上ある現場。仕様 D71)
  function hasPartners(config, siteCode) {
    return visibleCompanies(config, siteCode).length > 0;
  }

  // URL の s で読む要素の数の上限と、画面に出す一覧に無いコードの数の上限(仕様 D49)
  var MAX_PARAM_ITEMS = 50;
  var MAX_SHOWN_UNKNOWN = 3;

  // コードの接頭辞(最初の - まで。- が無ければ空)
  function codePrefix(code) {
    var i = code.indexOf('-');
    return i === -1 ? '' : code.slice(0, i + 1);
  }

  // URL の s(現場コードをカンマで並べたもの)を読む。仕様 D48・D49
  // 戻り値 = { codes: 一覧にあるコード(重複なし・URL の順), unknown: 一覧に無い要素の数,
  //           shown: そのうち画面に出してよいもの(コードの形で、一覧のコードと同じ接頭辞のもの。最大 3 件) }
  function parseSiteParam(config, raw) {
    var codes = [], shown = [], unknown = 0, seen = {};
    var prefixes = config.sites.map(function (s) { return codePrefix(s.code); });
    // 一覧のコードに - の無いものがあれば、接頭辞では絞らない
    var byPrefix = prefixes.indexOf('') === -1;
    String(raw || '').split(',', MAX_PARAM_ITEMS).forEach(function (part) {
      var v = part.trim();
      if (!v || seen['$' + v]) return;
      seen['$' + v] = true;
      if (findSite(config, v)) {
        codes.push(v);
      } else {
        unknown++;
        // URL の文字は、コードの形で一覧と同じ接頭辞のものだけを画面に出す(任意の文を公式の枠に表示させない)
        if (CODE_RE.test(v) && (!byPrefix || prefixes.indexOf(codePrefix(v)) !== -1) && shown.length < MAX_SHOWN_UNKNOWN) shown.push(v);
      }
    });
    return { codes: codes, unknown: unknown, shown: shown };
  }

  // 入口の種類: 一覧にあるコードが 1 つ = single(現場 QR)・2 つ以上 = list(社員用リンク)・0 = all(全現場)
  function entryMode(codes) {
    return codes.length === 1 ? 'single' : codes.length >= 2 ? 'list' : 'all';
  }

  // 全現場の選択で、部署で絞り・コードで探す(部分一致・大文字小文字を区別しない)
  function filterSites(config, dept, query) {
    var q = String(query || '').trim().toLowerCase();
    return config.sites.filter(function (s) {
      return (!dept || s.dept === dept) && (!q || s.code.toLowerCase().indexOf(q) !== -1);
    });
  }

  // 部署コードの一覧(sites の並び順・重複なし)
  function deptsOf(config) {
    var out = [];
    config.sites.forEach(function (s) {
      if (out.indexOf(s.dept) === -1) out.push(s.dept);
    });
    return out;
  }

  // 「自分が実施」の実施者(会社 = 自社・立場 = その他 + 氏名)。送る中身の形は変えない
  function selfMembers(config, name) {
    return [{ company: config.ownCompany, role: config.otherRole, name: String(name || '') }];
  }

  // 社員が自分の分を送るときの氏名 = 立場の語 + 半角の空白 + 氏名(試用の間の仮。送る中身の形と版は変えない。仕様 D118)。
  // 氏名が空なら空(立場の語だけで送らせない)
  function staffName(token, name) {
    var n = String(name || '').trim();
    return n && token ? token + ' ' + n : n;
  }

  // 画面に出す会社名。自社の文字は社名で出す(送る値と印は自社の文字のまま。仕様 D119)
  function displayCompany(config, c) {
    return c === config.ownCompany && config.ownCompanyLabel ? config.ownCompanyLabel : c;
  }

  // 社員の立場の語 → 画面の名前(config.staffRoles。仕様 D118)
  function staffRoleLabel(config, token) {
    var hit = (config.staffRoles || []).filter(function (r) { return r.token === token; })[0];
    return hit ? hit.label : '';
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

  // 写真ごとのコメント: 前後の空白(全角を含む)を除いた形(送る値)
  function cleanComment(c) {
    return typeof c === 'string' ? c.trim() : '';
  }

  // 写真ごとの会社の印(仕様 D77): 全角の角括弧で会社名を囲む。受け側はコメントが「［会社名］」で始まる写真を数える
  var PICK_OPEN = '［';  // ［
  var PICK_CLOSE = '］'; // ］
  function pickMarker(company) {
    return PICK_OPEN + company + PICK_CLOSE;
  }

  // 送るコメント = 選んだ会社があれば「［会社名］ 自由記入」(自由記入が空なら印だけ)、無ければ自由記入だけ。
  // 印は欄に書き込まず、送るときにここで付ける(手で崩せない形にする。仕様 D78)
  function composeComment(pick, text) {
    var c = cleanComment(text);
    if (!pick) return c;
    return c ? pickMarker(pick) + ' ' + c : pickMarker(pick);
  }

  // 自由記入の先頭に ［ や [ を書かせない(会社の印と見分けがつかなくなるため。仕様 D78・review security-R1-001)
  function freeTextProblem(text) {
    var v = cleanComment(text);
    return v !== '' && nfkc(v).charAt(0) === '[';
  }

  // 会社名に使えない括弧(印の鍵が別の会社の頭にならないように。仕様 D79・review security-R1-002)
  function bracketInName(c) {
    return /[\[\]［］]/.test(nfkc(c));
  }

  // その写真で選べる会社 = 自社の文字(先頭)+ その現場の一覧の会社(一覧の並び)。
  // その現場の一覧が無いときは空(選ぶ欄を出さない。仕様 D79)
  function targetsForSite(config, siteCode) {
    var out = [];
    (config.targets || []).forEach(function (t) {
      if (t.site === siteCode && t.company !== config.ownCompany && out.indexOf(t.company) === -1) out.push(t.company);
    });
    return out.length ? [config.ownCompany].concat(out) : [];
  }

  // 写真ごとのコメントの使えない書き方(仕様 D62。受付の isSafeComment_ と同じ決まり)。
  // 戻り値 = null(使える・空を含む)/ 'length' / 'char' / 'head' / 'link'。
  // 広いドメインの形(HOST_RE)は句点(。)をそろえずに見る(「3F。NG」を拒まないため)。一覧の形(LINK_RE)は句点をそろえた形でも見る
  var COMMENT_SCHEME_RE = /\b(file|smb|search|search-ms|ms-[a-z-]+|mailto|news|nntp|telnet|outlook|onenote|notes|shell|callto|tel|sip|ldap):/i;
  function commentProblem(c) {
    var v = cleanComment(c);
    if (v === '') return null;
    var n = v.normalize ? v.normalize('NFKC') : v;
    if (Array.from(v).length > MAX_COMMENT) return 'length';
    if (BAD_CHAR_RE.test(v) || /\p{Cs}/u.test(v) || /[;|=]/.test(v) || /[;|=]/.test(n) || v.indexOf('---') !== -1 || n.indexOf('---') !== -1) return 'char';
    if (/^[=+\-@]/.test(n)) return 'head';
    if (/\\/.test(n) || LINK_RE.test(n) || looksLikeLink(v) || HOST_RE.test(n) || COMMENT_SCHEME_RE.test(n)) return 'link';
    return null;
  }

  // 画面に出す理由(仕様の「画面の文言」)。i は 0 から
  function commentMessage(i, c) {
    var k = commentProblem(c);
    var head = '写真 ' + (i + 1) + ' のコメント';
    if (k === 'length') return head + 'は ' + MAX_COMMENT + ' 字までにしてください(いま ' + Array.from(cleanComment(c)).length + ' 字)';
    if (k === 'char') return head + 'に、使えない字があります(; | = 、--- 、改行、見えない字)';
    if (k === 'head') return head + 'の先頭に = + - @ は使えません';
    if (k === 'link') return head + 'に、URL・メールアドレス・ドメインの形と \\ は書けません';
    return null;
  }

  // 写真ごとの理由(選んだ会社と自由記入から。仕様 D78)。会社を選んだときの長さの理由は「会社名を含めて」と出す(review ux-R1-004)
  function photoCommentMessage(i, pick, text) {
    var head = '写真 ' + (i + 1) + ' のコメント';
    if (freeTextProblem(text)) return head + 'の先頭に ［ や [ は使えません(会社の印に使うため)。【 】や( )なら使えます';
    var c = composeComment(pick, text);
    if (pick && commentProblem(c) === 'length') return head + 'は、会社名とその括弧を含めて ' + MAX_COMMENT + ' 字までにしてください(いま ' + Array.from(c).length + ' 字)';
    return commentMessage(i, c);
  }

  /*
   * state = { date, dept, site, members: [{ company, role, name }], photoCount, photoComments: [送る文字列…],
   *           photoPicks: [選んだ会社…], photoTexts: [自由記入…] }(photoPicks・photoTexts があればそれで確かめる。仕様 D78)
   * 戻り値 = 欠けている・誤っている項目の一覧。空なら確認へ進める。
   */
  function validate(state, config, now) {
    var errors = [];
    var s = state || {};

    // どの入口でも、最初に「社員」か「協力会社の方」かを選び、社員は立場と何を送るかを選ぶ(仕様 D117・D118)
    if (s.whoRequired && !s.who) {
      errors.push({ field: 'who', message: s.kind === 'staff' ? '立場と、何を送るかを選んでください' : '最初に「社員」か「協力会社の方」かを選んでください' });
    }
    if ((s.who === 'self' || s.who === 'paper') && (config.staffRoles || []).length && !staffRoleLabel(config, s.staffRole)) {
      errors.push({ field: 'who', message: '立場を選んでください' });
    }

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
    // 「自分が実施」は会社が自社に決まっているので、会社の選択を求めない(現場の未選択は上で出る)。
    // 現場を選んだ後は、実施者が自社の 1 行であることを確かめる(security-R2-005)
    if (s.who === 'self') {
      if (s.site && site && (members.length !== 1 || members[0].company !== config.ownCompany)) {
        errors.push({ field: 'companies', message: 'この現場の一覧に' + displayCompany(config, config.ownCompany) + 'がありません。担当に連絡してください' });
      }
    } else if (members.length === 0) {
      errors.push({ field: 'companies', message: '実施した会社を 1 社以上選んでください' });
    } else if (members.length > MAX_COMPANIES) {
      errors.push({ field: 'companies', message: '会社は ' + MAX_COMPANIES + ' 社までにしてください' });
    }
    members.forEach(function (m) {
      var shown = displayCompany(config, m.company);
      // 社員の自分の分の氏名は、頭に立場の語が付いた形で数える(仕様 D118)
      var withRole = s.who === 'self' && m.company === config.ownCompany && s.staffRole;
      if ((config.roles || []).indexOf(m.role) === -1) {
        errors.push({ field: 'roles', message: '「' + shown + '」で実施した人の立場を選んでください' });
      } else if (m.role === config.otherRole && !m.name) {
        errors.push({ field: 'roles', message: '「' + shown + '」で実施した人の氏名を入れてください' });
      } else if (m.role === config.otherRole && !isValidName(m.name)) {
        errors.push({ field: 'roles', message: withRole ?
          '氏名は、頭に付ける立場(' + s.staffRole + ' と空白)を含めて ' + MAX_NAME + ' 文字までで、; | = / @ と URL は使えません' :
          '「' + shown + '」の氏名は ' + MAX_NAME + ' 文字までで、; | = / @ と URL は使えません(先頭に + - も使えません)' });
      }
    });

    if (!(s.photoCount >= 1)) {
      errors.push({ field: 'photos', message: 'チェックシートの写真か PDF を 1 件以上選んでください' });
    } else if (s.photoCount > MAX_PHOTOS) {
      errors.push({ field: 'photos', message: '写真・PDF は ' + MAX_PHOTOS + ' 件までにしてください' });
    }
    (s.photoComments || []).forEach(function (c, i) {
      var m = s.photoTexts ? photoCommentMessage(i, (s.photoPicks || [])[i] || '', s.photoTexts[i]) : commentMessage(i, c);
      if (m) errors.push({ field: 'comments', message: m });
    });

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

  function pdfTooBig(i) {
    return (i + 1) + ' 件目の PDF が大きすぎます(1 件 5 MB まで)。別のファイルを選ぶか、PDF を小さく作り直してください。';
  }

  // 用意した写真 [{ type, data }] が送れるか。送れないときは本人に見せる文
  function checkPhotos(photos) {
    var hasPdf = photos.some(function (x) { return x.type === PDF_TYPE; });
    if (!photos.length || photos.length > MAX_PHOTOS) return hasPdf ? '写真・PDF は 1〜' + MAX_PHOTOS + ' 件にしてください。' : '写真は 1〜' + MAX_PHOTOS + ' 枚にしてください。';
    var total = 0;
    for (var i = 0; i < photos.length; i++) {
      var p = photos[i];
      // PDF は別の枝(写真の検査は下のまま変えない。仕様 D125)
      if (p.type === PDF_TYPE) {
        var pn = base64Bytes(p.data);
        if (pn > MAX_PDF_BYTES) return pdfTooBig(i);
        if (p.data.indexOf(PDF_B64_HEAD) !== 0) return (i + 1) + ' 件目の PDF は、PDF のファイルとして読めませんでした。別のファイルを選んでください。';
        if (pn <= MIN_PDF_BYTES) return (i + 1) + ' 件目の PDF が小さすぎます(20 KB より大きいものだけ送れます)。別のファイルを選ぶか、書類の写真で送ってください。';
        total += pn;
        continue;
      }
      if (p.type !== 'image/jpeg' && p.type !== 'image/png') return (i + 1) + ' 枚目の写真はこの端末で送れる形(JPEG)にできませんでした。カメラで撮り直すか、別の写真を選んでください。';
      var n = base64Bytes(p.data);
      if (n > MAX_PHOTO_BYTES) return (i + 1) + ' 枚目の写真が大きすぎます(1 枚 1.5 MB まで)。撮り直すか、別の写真を選んでください。';
      total += n;
    }
    if (total > MAX_TOTAL_BYTES) return hasPdf ? '写真・PDF の合計が大きすぎます(8 MB まで)。件数を減らしてください。' : '写真の合計が大きすぎます(8 MB まで)。枚数を減らしてください。';
    return null;
  }

  // 受付へ送る中身(仕様 D21 の JSON。v3 で comments を足した。仕様 D63)。件名・本文・宛先は受付が決める。
  // comments は写真の順に、写真と同じ数(空のコメントは空の文字列)
  function buildPayload(state, config, meta, photos, device) {
    var comments = state.photoComments || [];
    return {
      p: PROTOCOL,
      formId: config.formId,
      formVersion: FORM_VERSION,
      ref: meta.ref,
      date: state.date,
      dept: state.dept,
      site: state.site,
      members: normalizeMembers(config, state.site, state.members).map(function (m) {
        return m.role === config.otherRole ? { company: m.company, role: m.role, name: m.name } : { company: m.company, role: m.role };
      }),
      created: meta.created,
      device: device,
      photos: photos.map(function (p) { return { type: p.type, data: p.data }; }),
      comments: photos.map(function (p, i) { return cleanComment(comments[i]); })
    };
  }

  // 時間切れまでの長さ: 60 秒 + 送る量(1 秒に約 16 KB)。最長 6 分(受付の 1 回の実行の上限に合わせた [推定]:
  // 送る時間が受付の実行時間に含まれるかは確かめていない。実機の確認 USER-STEP w で見直す)
  function timeoutMs(chars) {
    return Math.min(360000, 60000 + Math.ceil(chars / 16));
  }

  // 会社名として使えない文字か。; = 改行は本文の区切り、先頭の = + - @ は表計算で式と読まれるため使えない。
  // 前後の空白も不可(受け側は空白を取ってマスタと照らすため、食い違いの元になる)。長さは受付と同じ 60 文字まで
  function badCompanyText(c) {
    return typeof c !== 'string' || !c || c.length > 60 || /[;|=]/.test(c) || BAD_CHAR_RE.test(c) || looksLikeLink(c) || /^[=+\-@]/.test(nfkc(c)) || c !== c.trim();
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
    // 自社の文字(「自分が実施」の会社)は会社名と同じ決まり(仕様 D52)
    if (badCompanyText(config.ownCompany)) problems.push('ownCompany');
    // 自社の文字は写真ごとの会社の先頭の選択肢でもある(印を付けたコメントの決まりに合うこと。review engineer-R1-005)
    if (typeof config.ownCompany === 'string' && (commentProblem(pickMarker(config.ownCompany)) || bracketInName(config.ownCompany))) problems.push('ownCompany:pick');
    // 画面に出す自社の名前(仕様 D119)。無くてもよい(そのときは自社の文字のまま出す)
    if (config.ownCompanyLabel !== undefined && badCompanyText(config.ownCompanyLabel)) problems.push('ownCompanyLabel');
    // 社員の立場(仕様 D118)。語は氏名の頭に付けて送るので、氏名と同じ決まりで、空白を含まない短い語
    if (config.staffRoles !== undefined) {
      if (!Array.isArray(config.staffRoles) || !config.staffRoles.length) {
        problems.push('staffRoles');
      } else {
        var seenRoles = {};
        config.staffRoles.forEach(function (r, i) {
          if (!r || typeof r.label !== 'string' || !r.label || r.label.length > 20 || BAD_CHAR_RE.test(r.label) ||
              typeof r.token !== 'string' || !isValidName(r.token) || /\s/.test(r.token) || r.token.length > 8 || seenRoles['$' + r.token]) {
            problems.push('staffRoles[' + i + ']');
          }
          if (r && typeof r.token === 'string') seenRoles['$' + r.token] = true;
        });
      }
    }
    (config.roster || []).forEach(function (r, i) {
      if (badCompanyText(r.company)) problems.push('roster[' + i + '].company');
      if (!findSite(config, r.site)) problems.push('roster[' + i + '].site');
      // 公開してよいのは現場コードと会社名だけ(ほかの項目が紛れ込んだら止める)
      if (Object.keys(r).some(function (k) { return k !== 'site' && k !== 'company'; })) problems.push('roster[' + i + '].keys');
    });
    if (!(config.roster || []).length) problems.push('roster');
    // 立場は本文の書式(版)の一部。受け側の流れと同じ 3 つ・同じ順でなければ止める(変えるときは版を上げる)
    if (JSON.stringify(config.roles) !== JSON.stringify(ROLES_V2) || config.otherRole !== ROLES_V2[2]) problems.push('roles');
    // どの現場にも自社の行があること(仕様 D52)。自社以外の会社が 0 社の現場は誤りにしない(協力会社の道では選べない。仕様 D71・D117)
    (config.sites || []).forEach(function (s) {
      if (companiesForSite(config, s.code).indexOf(config.ownCompany) === -1) problems.push('roster-own:' + s.code);
    });
    // 写真ごとに選べる会社の一覧(仕様 D79)。ファイルが無いときは選ぶ欄を出さないだけ(誤りにしない)
    var seenTargets = {};
    (config.targets || []).forEach(function (t, i) {
      if (!t || typeof t !== 'object' || Object.keys(t).some(function (k) { return k !== 'site' && k !== 'company'; })) {
        problems.push('targets[' + i + '].keys');
        return;
      }
      if (!findSite(config, t.site)) problems.push('targets[' + i + '].site');
      if (badCompanyText(t.company) || commentProblem(pickMarker(t.company)) || bracketInName(t.company)) problems.push('targets[' + i + '].company');
      if (t.company === config.ownCompany) problems.push('targets[' + i + '].own');
      var key = t.site + '\n' + t.company;
      if (seenTargets[key]) problems.push('targets[' + i + '].dup');
      seenTargets[key] = true;
    });
    return problems;
  }

  var Core = {
    todayLocal: todayLocal,
    isRealDate: isRealDate,
    findSite: findSite,
    companiesForSite: companiesForSite,
    visibleCompanies: visibleCompanies,
    hasPartners: hasPartners,
    staffName: staffName,
    displayCompany: displayCompany,
    staffRoleLabel: staffRoleLabel,
    parseSiteParam: parseSiteParam,
    entryMode: entryMode,
    filterSites: filterSites,
    deptsOf: deptsOf,
    selfMembers: selfMembers,
    normalizeMembers: normalizeMembers,
    isValidName: isValidName,
    cleanComment: cleanComment,
    commentProblem: commentProblem,
    commentMessage: commentMessage,
    pickMarker: pickMarker,
    composeComment: composeComment,
    freeTextProblem: freeTextProblem,
    photoCommentMessage: photoCommentMessage,
    targetsForSite: targetsForSite,
    FORM_VERSION: FORM_VERSION,
    MAX_COMMENT: MAX_COMMENT,
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
  // 写真ごとに選べる会社の一覧(targets.js)。無い・読めないときは選ぶ欄を出さない(仕様 D79)
  config.targets = Array.isArray(root.PATROL_TARGETS) ? root.PATROL_TARGETS : [];
  var O = root.PatrolOutbox;

  // kind = ''(まだ選んでいない)/ 'staff'(社員)/ 'partner'(協力会社の方)。仕様 D117
  // who = 'partner'(協力会社が自分の紙を送る)/ 'paper'(社員が協力会社の紙を代わりに送る)/ 'self'(社員が自分で実施した分)
  // staffRole = 社員の立場の語(config.staffRoles の token。仕様 D118)
  var state = { date: '', dept: '', site: '', members: [], photoCount: 0, photoComments: [], who: '', whoRequired: true, kind: '', staffRole: '' };
  var selfName = '';   // 「自分が実施」の氏名(続けて入れるときも残す)
  // 開いたときの入口(URL の s から決める。仕様 D48)
  var entry = { mode: 'all', codes: [], unknown: 0, shown: [] };

  // 自分の分の実施者(氏名の頭に立場の語。仕様 D118)
  function selfMembersNow() {
    return selfMembers(config, staffName(state.staffRole, selfName));
  }
  var chooserKind = 'all';
  var rechooseFrom = null; // 選び直しの確かめを開いたボタン(「やめる」でフォーカスを戻す)
  var photos = [];     // { file, url, comment, pick }(pick = 選んだ会社。'' = 指定なし。仕様 D78)
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

  function isPdf(file) {
    return !!file && file.type === PDF_TYPE;
  }

  // 大きさの見せ方(KB は四捨五入・1 MB 以上は小数 1 桁)
  function fileSize(n) {
    return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';
  }

  // 一覧と確認画面の見本: 写真は画像・PDF は「PDF・ファイル名・大きさ」の札(中身は開かない。CSP は変えない。仕様 D127)
  function thumb(p, i) {
    if (!isPdf(p.file)) return el('img', { src: p.url, alt: 'チェックシートの写真 ' + (i + 1) });
    var card = el('div', { 'class': 'pdf-card' });
    card.appendChild(el('strong', { 'class': 'pdf-mark' }, 'PDF'));
    card.appendChild(el('span', { 'class': 'pdf-name' }, p.file.name));
    card.appendChild(el('span', { 'class': 'pdf-size' }, fileSize(p.file.size)));
    return card;
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
    // 新しい現場の一覧に無い会社の選択は「指定なし」に戻す(自由記入は残す。仕様 D78)
    var choices = targetsForSite(config, state.site);
    var changed = false;
    photos.forEach(function (p) {
      if (p.pick && choices.indexOf(p.pick) === -1) { p.pick = ''; changed = true; }
    });
    // 黙って戻さず、戻したことを知らせる(review ux-R1-003)。知らせは「続けて別の記録を入れる」まで残す
    // (選び直しの途中の setSite('') の後の setSite で消さない。review ux-R2-001・engineer-R2-001)。
    // 欄は隠さずに文字だけ入れ替える(隠した欄を出すと読み上げられないことがあるため。review ux-R2-002)
    if (changed) $('pick-reset').textContent = '現場が変わったので、写真ごとの会社の選択を「指定なし」に戻したものがあります。写真ごとに確かめてください。';
    if (photos.length) renderPhotos();
  }

  // 送るコメント(印つき)を写真の順にそろえる(仕様 D78)
  function syncComments() {
    state.photoComments = photos.map(function (q) { return composeComment(q.pick, q.comment); });
    state.photoPicks = photos.map(function (q) { return q.pick || ''; });
    state.photoTexts = photos.map(function (q) { return q.comment || ''; });
  }

  // 選択肢を作り直す。いま選んでいる現場が選択肢から外れたら、未選択に戻す。
  // 協力会社の紙(partner・paper)では、自社以外の会社が 0 社の現場を出さない(会社を選べずに止まるため。仕様 D71)
  function fillSiteOptions(list) {
    if (state.who === 'partner' || state.who === 'paper') list = list.filter(function (s) { return hasPartners(config, s.code); });
    var sel = $('site-select');
    sel.textContent = '';
    sel.appendChild(el('option', { value: '' }, '選んでください'));
    list.forEach(function (s) {
      sel.appendChild(el('option', { value: s.code }, s.code + '(部署 ' + s.dept + ')'));
    });
    var still = list.some(function (s) { return s.code === state.site; });
    if (!still && state.site) setSite('');
    sel.value = state.site;
  }

  function sitesOfCodes(codes) {
    return codes.map(function (c) { return findSite(config, c); });
  }

  // 現場の選び方を切り替える: 'fixed'(URL の 1 現場)/ 'list'(リンクの現場だけ)/ 'all'(全現場・部署で絞る・コードで探す)
  function showChooser(kind) {
    chooserKind = kind;
    $('site-confirm').hidden = true;
    $('site-fixed').hidden = kind !== 'fixed';
    $('site-choose').hidden = kind === 'fixed';
    $('site-filter').hidden = kind !== 'all';
    $('site-outside').hidden = kind !== 'list';
    $('site-list-hint').hidden = kind !== 'list';
    if (kind === 'fixed') {
      setSite(entry.codes[0]);
    } else {
      if (kind !== 'list') {
        $('site-dept').value = '';
        $('site-search').value = '';
      }
      refillSites();
    }
    renderWho();
  }

  // 今の選び方の選択肢を作り直す(「協力会社の紙」と「自分が実施」で出す現場が違うため。仕様 D71)
  function refillSites() {
    if (chooserKind === 'list') {
      fillSiteOptions(sitesOfCodes(entry.codes));
      $('site-list-hint').textContent = 'リンクの現場(' + ($('site-select').options.length - 1) + ' 件)から選んでください。';
    } else if (chooserKind === 'all') {
      fillSiteOptions(filterSites(config, $('site-dept').value, $('site-search').value));
    }
  }

  // 「違う現場を選ぶ」「一覧の外の現場を選ぶ」は、押した後に確かめる(仕様 D50)
  function askRechoose(e) {
    rechooseFrom = e && e.currentTarget ? e.currentTarget.id : null;
    $('site-confirm').hidden = false;
    $('site-confirm-yes').focus();
  }

  function renderSiteNotice() {
    var box = $('site-notice');
    if (!entry.unknown) {
      box.hidden = true;
      return;
    }
    // 決まった文と件数。URL の文字はコードの形のものだけを出す(仕様 D49)
    box.hidden = false;
    var rest = entry.unknown - entry.shown.length;
    box.textContent = 'リンクの中に、この一覧に無い現場コードが ' + entry.unknown + ' 件ありました。配られた紙の現場コードを確かめてください。' +
      (entry.shown.length ? '(' + entry.shown.join('、') + (rest > 0 ? ' ほか ' + rest + ' 件' : '') + ')' : '');
  }

  function renderSiteChoice() {
    var sel = $('site-select');
    sel.addEventListener('change', function () {
      setSite(sel.value);
      renderCompanies();
      refresh();
    });
    $('site-dept').appendChild(el('option', { value: '' }, 'すべての部署'));
    deptsOf(config).forEach(function (d) {
      $('site-dept').appendChild(el('option', { value: d }, '部署 ' + d));
    });
    function applyFilter() {
      fillSiteOptions(filterSites(config, $('site-dept').value, $('site-search').value));
      renderCompanies();
      refresh();
    }
    $('site-dept').addEventListener('change', applyFilter);
    $('site-search').addEventListener('input', applyFilter);
    $('site-change').addEventListener('click', askRechoose);
    $('site-outside').addEventListener('click', askRechoose);
    $('site-confirm-yes').addEventListener('click', function () {
      setSite(''); // 選び直すときは、前の現場を残さない
      showChooser('all');
      renderCompanies();
      refresh();
      $('site-select').focus();
    });
    $('site-confirm-no').addEventListener('click', function () {
      $('site-confirm').hidden = true;
      if (rechooseFrom) refocus(rechooseFrom);
    });

    // ページが読む URL のパラメータは s だけ(仕様 D48)
    var parsed = parseSiteParam(config, new URLSearchParams(root.location.search).get('s'));
    entry = { mode: entryMode(parsed.codes), codes: parsed.codes, unknown: parsed.unknown, shown: parsed.shown };
    // どの入口でも(現場 QR・社員用リンク・全現場・一覧に無いコードだけ)、最初に「社員」か「協力会社の方」かを選ぶ(仕様 D117。
    // 前の「協力会社 0 社の現場は自分が実施で始める」(D71)と「現場 QR は協力会社の画面で始める」(D52)の入口の違いは無くした)
    state.whoRequired = true;
    state.kind = '';
    state.who = '';
    renderSiteNotice();
    showChooser(entry.mode === 'single' ? 'fixed' : entry.mode);
  }

  // 最初の 2 択(社員 / 協力会社の方)→ 社員は立場と何を送るか → 入力(仕様 D117・D118・D52・D53)
  function renderWho() {
    var label = displayCompany(config, config.ownCompany);
    var roleLabel = staffRoleLabel(config, state.staffRole);
    $('kind').hidden = !!state.kind;
    $('who').hidden = !(state.kind === 'staff' && !state.who);
    $('who-chosen').hidden = !state.who;
    $('who-chosen-text').textContent = state.who === 'partner' ? '協力会社の方として送ります' :
      state.who === 'self' ? label + 'の社員' + (roleLabel ? '(' + roleLabel + ')' : '') + '・自分のチェックシートを送ります' :
      state.who === 'paper' ? label + 'の社員' + (roleLabel ? '(' + roleLabel + ')' : '') + '・協力会社の紙を代わりに送ります' : '';
    $('input-body').hidden = !state.who;
    $('note-partner').hidden = state.who !== 'partner';
    $('note-staff').hidden = state.who !== 'paper';
    $('companies-box').hidden = state.who === 'self';
    $('self-box').hidden = state.who !== 'self';
    $('self-company').textContent = label;
    // 立場の設定(config.staffRoles)が無い版の設定では、立場を問わない(立場は今までどおり「その他」)
    var needRole = (config.staffRoles || []).length > 0;
    $('self-role').textContent = roleLabel || config.otherRole;
    $('staff-roles').hidden = !needRole;
    // 立場を選ぶまで「何を送るか」は押せない
    $('who-self').disabled = needRole && !roleLabel;
    $('who-paper').disabled = needRole && !roleLabel;
    // 氏名の欄は、頭に付ける立場の語と空白の分だけ短くする(仕様 D118)
    $('self-name').maxLength = MAX_NAME - (state.staffRole ? state.staffRole.length + 1 : 0);
  }

  function setWho(who) {
    state.who = who;
    state.members = who === 'self' ? selfMembersNow() : [];
    refillSites();
    renderWho();
    renderCompanies();
    refresh();
  }

  // 最初の 2 択へ戻る(立場の選択も外す)
  function backToKind() {
    state.kind = '';
    state.staffRole = '';
    Array.prototype.forEach.call(doc.querySelectorAll('input[name="staff-role"]'), function (x) { x.checked = false; });
    setWho('');
    refocus('kind-staff');
  }

  function initWho() {
    var label = displayCompany(config, config.ownCompany);
    $('kind-staff').textContent = label + 'の社員';
    // 押したボタンが隠れるときは、次に操作する欄へフォーカスを移す(engineer-R1-006)
    $('kind-staff').addEventListener('click', function () { state.kind = 'staff'; setWho(''); refocus((config.staffRoles || []).length ? 'staff-role-0' : 'who-self'); });
    $('kind-partner').addEventListener('click', function () { state.kind = 'partner'; setWho('partner'); refocus('date'); });
    // 社員の立場(config.staffRoles の並び。仕様 D118)
    var box = $('staff-roles');
    (config.staffRoles || []).forEach(function (r, i) {
      var rid = 'staff-role-' + i;
      var lab = el('label', { 'for': rid, 'class': 'check' });
      var radio = el('input', { type: 'radio', id: rid, name: 'staff-role', value: r.token });
      radio.addEventListener('change', function () {
        state.staffRole = r.token;
        renderWho();
        refresh();
      });
      lab.appendChild(radio);
      lab.appendChild(el('span', null, r.label));
      box.appendChild(lab);
    });
    $('who-paper').addEventListener('click', function () { setWho('paper'); refocus('date'); });
    $('who-self').addEventListener('click', function () { setWho('self'); refocus('date'); });
    $('kind-back').addEventListener('click', backToKind);
    $('who-change').addEventListener('click', backToKind);
    $('self-name').addEventListener('input', function () {
      selfName = $('self-name').value;
      if (state.who === 'self') state.members = selfMembersNow();
      refresh();
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
    box.textContent = '';
    if (state.who === 'self') {
      state.members = selfMembersNow();
      return;
    }
    state.members = normalizeMembers(config, state.site, state.members).filter(function (m) { return m.company !== config.ownCompany; });
    $('company-empty').hidden = !!state.site;
    // 協力会社の一覧が無い現場(現場 QR で開いたとき)は、行き止まりにしないで社員の道を案内する(仕様 D117)
    $('company-none').hidden = !(state.site && !hasPartners(config, state.site));
    $('company-none').textContent = state.who === 'paper' ?
      'この現場には、選べる協力会社がありません。自分の分を送るときは、上の「選び直す」から「自分のチェックシートを送る」を選んでください。' :
      'この現場には、選べる協力会社がありません。社員の方は、上の「選び直す」から社員を選んでください。';
    visibleCompanies(config, state.site).forEach(function (c, i) {
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
    var choices = targetsForSite(config, state.site);
    photos.forEach(function (p, i) {
      var li = el('li', { 'class': 'photo' });
      li.appendChild(thumb(p, i));
      // 写真ごとのコメント(任意・1 行。仕様 D61)。入力のたびに確かめ、理由を欄の下に出す
      var id = 'photo-comment-' + i;
      // 作り直し(現場を替えたとき)で古い理由が読み上げ直されないよう、role=alert ではなく polite にする(review ux-R1-003)
      var err = el('p', { id: id + '-error', 'class': 'error comment-error', 'aria-live': 'polite' });
      var input = el('input', { type: 'text', id: id, 'class': 'photo-comment', autocomplete: 'off', 'aria-describedby': id + '-error' });
      // 理由が変わったときだけ書き換える(打つたびに同じ理由が読み上げられないように。review engineer の所見)。
      // 確かめるのは印の付いた送る値(仕様 D78)
      var showErr = function () {
        var m = photoCommentMessage(i, p.pick, p.comment) || '';
        // 欄は隠さず、文字だけ入れ替える(review ux-R2-002)
        if (err.textContent !== m) err.textContent = m;
        input.setAttribute('aria-invalid', m ? 'true' : 'false');
      };
      // 写真ごとの会社(任意・仕様 D77)。その現場の一覧があるときだけ出す
      if (choices.length) {
        var pid = 'photo-pick-' + i;
        li.appendChild(el('label', { 'for': pid, 'class': 'comment-label' }, '写真 ' + (i + 1) + ' はどの会社の指摘か(任意)'));
        var sel = el('select', { id: pid, 'class': 'photo-pick', 'aria-describedby': id + '-error' });
        sel.appendChild(el('option', { value: '' }, '指定なし(どの会社とも言えない)'));
        choices.forEach(function (c) {
          // 値は自社の文字のまま、見える名前だけ社名(仕様 D119)
          sel.appendChild(el('option', { value: c }, displayCompany(config, c)));
        });
        sel.value = p.pick || '';
        sel.addEventListener('change', function () {
          p.pick = sel.value;
          syncComments();
          showErr();
          refresh();
        });
        li.appendChild(sel);
      }
      li.appendChild(el('label', { 'for': id, 'class': 'comment-label' }, '写真 ' + (i + 1) + ' のコメント(任意・' + (choices.length ? '会社名を含めて ' : '') + MAX_COMMENT + ' 字まで)'));
      input.value = p.comment || '';
      input.addEventListener('input', function () {
        p.comment = input.value;
        syncComments();
        showErr();
        refresh();
      });
      li.appendChild(input);
      li.appendChild(err);
      showErr();
      var rm = el('button', { type: 'button', 'class': 'link' }, isPdf(p.file) ? 'この PDF を外す' : 'この写真を外す');
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
    syncComments();
    $('photo-count').textContent = photos.length ? '選んだ写真・PDF: ' + photos.length + ' 件' : 'まだ選んでいません';
  }

  function refresh() {
    // 送る氏名は欄に見えている値(ブラウザが欄の値を戻したときは input が出ないため、ここで読む。仕様 D72)
    if (state.who === 'self') {
      selfName = $('self-name').value;
      state.members = selfMembersNow();
    }
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
      return displayCompany(config, m.company) + '(' + m.role + (m.role === config.otherRole ? ': ' + m.name : '') + ')';
    }).join('、');
  }

  function renderConfirm() {
    // 送る人(会社・立場・氏名)を大きく出し、本人かを確かめる(仕様 D120)
    var whoList = $('c-who-list');
    whoList.textContent = '';
    normalizeMembers(config, state.site, state.members).forEach(function (m) {
      var self = state.who === 'self' && m.company === config.ownCompany;
      var role = self ? (staffRoleLabel(config, state.staffRole) || m.role) : m.role;
      var name = self ? String(selfName || '').trim() : m.name;
      // 会社・立場・氏名を 1 行ずつ(途中で折れて読みにくくならないように)
      var li = el('li');
      li.appendChild(el('span', { 'class': 'who-line' }, '会社 ' + displayCompany(config, m.company)));
      li.appendChild(el('span', { 'class': 'who-line' }, '立場 ' + role));
      if (name) li.appendChild(el('span', { 'class': 'who-line' }, '氏名 ' + name));
      whoList.appendChild(li);
    });
    $('c-who-ask').textContent = state.who === 'paper' ? '紙に書かれた会社・立場と同じですか' : 'ご本人ですか';
    // 現場コードを大きく出す(取り違えの対策・仕様 D51)
    $('c-site-big').textContent = state.site;
    $('c-date').textContent = state.date;
    $('c-dept').textContent = state.dept;
    $('c-site').textContent = state.site;
    $('c-companies').textContent = membersText(normalizeMembers(config, state.site, state.members));
    $('c-photos').textContent = state.photoCount + ' 件';
    var list = $('c-photo-list');
    list.textContent = '';
    photos.forEach(function (p, i) {
      var li = el('li', { 'class': 'photo' });
      li.appendChild(thumb(p, i));
      // 写真とコメントの組(仕様 D61)。送る値(選んだ会社の印を含む。仕様 D78)と同じ形で出す
      var c = composeComment(p.pick, p.comment);
      li.appendChild(el('p', { 'class': c ? 'photo-comment-text' : 'photo-comment-text none' }, c || '(コメントなし)'));
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
    photos.forEach(function (p, idx) {
      chain = chain.then(function () {
        if (token !== prepToken) return;
        // 大きすぎる PDF は読み込む前に止める(何十 MB も読んで端末のメモリを使わない。仕様 D133)
        if (isPdf(p.file) && p.file.size > MAX_PDF_BYTES) throw new Error(pdfTooBig(idx));
        // PDF は縮小せずそのまま(仕様 D127)。写真は今までどおり縮小する
        return (isPdf(p.file) ? Promise.resolve(p.file) : shrinkPhoto(p.file)).then(toBase64).then(function (x) { out.push(x); });
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
      $('prep-error').textContent = (e && e.message && /枚目|件目|写真|PDF/.test(e.message)) ? e.message : '写真を準備できませんでした。写真を選び直してください。';
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
    return s.date + ' 現場 ' + s.site + '・会社 ' + s.companies + ' 社・写真・PDF ' + s.photos + ' 件';
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
    // 送れていない記録がある間は、プライベートブラウズの注意を常に出す(仕様 D54)
    $('private-warning').hidden = !(st.pending || st.blocked);

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
    // 続けて別の記録を入れるときは、最初の 2 択から始める(前の人の区分・立場・何を送るかを残さない。
    // 自分の分の氏名の欄は D72 のまま残す。仕様 D117・秘書の照合 P2-1)
    state.kind = '';
    state.staffRole = '';
    state.who = '';
    Array.prototype.forEach.call(doc.querySelectorAll('input[name="staff-role"]'), function (x) { x.checked = false; });
    state.members = [];
    // 現場を残すのは現場 QR で開いたときだけ(URL の現場に戻す)。社員用リンク・全現場では未選択に戻す(仕様 D51)
    if (entry.mode === 'single') {
      showChooser('fixed');
    } else {
      setSite('');
      showChooser(entry.mode);
    }
    $('date').value = '';
    $('date').max = todayLocal(); // 日付が変わっていたら、今日を選べるように
    $('prep-error').hidden = true;
    $('photo-over').hidden = true;
    $('pick-reset').textContent = '';
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

    initWho();
    renderSiteChoice();
    renderCompanies();

    var photoInput = $('photos');
    photoInput.addEventListener('change', function () {
      var over = 0;
      var skipped = 0;
      Array.prototype.forEach.call(photoInput.files || [], function (f) {
        // 写真(image/*)と PDF だけ入れる。それ以外は入れず、件数を知らせる
        if (f.type && f.type.indexOf('image/') !== 0 && f.type !== PDF_TYPE) { skipped++; return; }
        // 上限を超えた分は読み込まない(大量の写真で画面が重くならないように)
        if (photos.length >= MAX_PHOTOS) { over++; return; }
        photos.push({ file: f, url: root.URL.createObjectURL(f), comment: '', pick: '' });
      });
      photoInput.value = '';
      var notes = [];
      if (over) notes.push('写真・PDF は ' + MAX_PHOTOS + ' 件までです。' + over + ' 件は入れませんでした。');
      if (skipped) notes.push('写真・PDF 以外のファイルが ' + skipped + ' 件ありました。入れませんでした。');
      $('photo-over').hidden = notes.length === 0;
      $('photo-over').textContent = notes.join(' ');
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
