/*
 * 送信の記録を端末に残し、送れるまで自動で送り直す仕組み(仕様 docs/specs/job/job-20260929-002.md D23・D26・D34)
 * - 判断の部分(classify / canAdd / createOutbox / startAutoRetry)は DOM に依存しない。保存先と送り手は差し替えられる(node から検査できる)
 * - 保存先の本物は IndexedDB(createIdbStore)。写真は base64 の文字列のまま持つ
 * - 「送信済み」にするのは、受付番号が返ってきたときだけ
 */
(function (root) {
  'use strict';

  var LIMITS = {
    pending: 10,                    // 送れていない記録(送れない記録を含む)の件数
    pendingChars: 60 * 1024 * 1024, // その写真の合計(base64 の文字数)
    hourly: 10,                     // この端末で 1 時間に作れる新しい送信
    sentKeepMs: 7 * 24 * 3600 * 1000
  };
  // 送り直しの間隔(秒)。失敗が続くほど延ばし、最長 5 分
  var BACKOFF = [15, 30, 60, 120, 300];
  var RECEIPT_RE = /^\d{4}-[A-Z2-9]{4}$/;
  // 通信そのものの失敗(電波が戻れば通る見込みがある)。これらだけは、電波が戻った・ページを開いたときに待ち時間を無視して送る
  var LINK_CODES = ['network', 'timeout', 'bad_response', 'no_receipt'];
  var JST = 9 * 3600 * 1000;
  // 時間切れが続いた記録(弱い電波で大きすぎる)は、この回数からは待ち時間を守る(開くたびに全部を送り直さない)
  var TIMEOUTS_BEFORE_BACKOFF = 2;
  // 次に送る時刻の上限(端末の時計のずれで、記録が長く止まらないように)
  var MAX_WAIT_MS = 25 * 3600 * 1000;
  // その記録だけの理由(ほかの記録は送ってよい)。これ以外の送れなかった理由は、ほかの記録も同じ時刻まで待たせる
  // 受付の設定がページより遅れていると起きる拒否(現場・部署・受付の方が古い版 = old_receiver)。
  // ページが確かめて作った記録なので、受付の設定が直れば通る。本人の手に頼らず、間を空けて自動で送り直し、
  // この回数を使い切ったら「送れません」にして「もう一度送る」を出す(review gemini TASK-008 R2)
  var CONFIG_CODES = ['bad_field:site', 'bad_field:dept', 'old_receiver'];
  var CONFIG_WAIT_S = [3600, 2 * 3600, 4 * 3600, 8 * 3600, 12 * 3600];
  var PER_RECORD_CODES = ['timeout', 'future_date'].concat(CONFIG_CODES);

  // 応答を 3 つに分ける: sent(受付番号あり)/ blocked(送り直しても通らない)/ pending(それ以外 = 後で送り直す)
  // ref を渡すと、応答の ref が送った ref と同じときだけ sent にする(別の送信の応答で済ませない)
  // payload = 送った中身(古い版の拒否で、受付とページのどちらが古いかを見分けるため)
  function classify(res, ref, payload) {
    if (res && res.ok === true && typeof res.receipt === 'string' && RECEIPT_RE.test(res.receipt) && (ref == null || res.ref === ref)) {
      return { state: 'sent', receipt: res.receipt };
    }
    if (res && res.ok === true) return { state: 'pending', code: 'bad_response' };
    if (res && res.ok === false && res.kind === 'final' && typeof res.code === 'string') {
      // 古い版の拒否は、受付の版(res.formVersion)が記録の版より古いときだけ「受付が古い」(old_receiver)。
      // それ以外(ページの方が古い・受付の版が分からない)は送り直しても通らない
      if (res.code === 'old_page' && typeof res.formVersion === 'number' && payload && typeof payload.formVersion === 'number' &&
          res.formVersion < payload.formVersion) {
        return { state: 'blocked', code: 'old_receiver' };
      }
      return { state: 'blocked', code: res.code };
    }
    if (res && res.ok === false && res.kind === 'retry' && typeof res.code === 'string') {
      // 受付が待つ時間を返したら(受付の時計で計算したもの)、それに従う
      var after = typeof res.retryAfterSec === 'number' && res.retryAfterSec >= 1 && res.retryAfterSec <= 90000 ? res.retryAfterSec : null;
      return { state: 'pending', code: res.code, retryAfterSec: after };
    }
    // 通信の失敗・読めない応答・受付番号の無い ok は、送れたとみなさない
    return { state: 'pending', code: (res && res.network && res.code) || 'no_receipt' };
  }

  function backoffMs(attempts) {
    return BACKOFF[Math.min(Math.max(attempts, 1), BACKOFF.length) - 1] * 1000;
  }

  // 次に送る時刻。受付全体の理由(1 日の上限・止めている等)は、すぐ送り直しても通らないので間を空ける。
  // 受付が待つ秒数(retryAfterSec・受付の時計)を返したときはそれを使い、無いときだけ端末の時計で計算する
  function nextTry(code, attempts, t, retryAfterSec) {
    var wait = backoffMs(attempts);
    if (retryAfterSec) return t + Math.max(wait, retryAfterSec * 1000);
    if (code === 'daily_limit' || code === 'future_date') {
      // 日本時間の翌日 0:05 まで待つ
      var day = Math.floor((t + JST) / 86400000) + 1;
      return Math.max(t + wait, day * 86400000 - JST + 5 * 60000);
    }
    if (code === 'device_limit') {
      // 日本時間の次の「時」の 1 分後まで待つ(受付の数えは時ごと)
      var hour = Math.floor((t + JST) / 3600000) + 1;
      return Math.max(t + wait, hour * 3600000 - JST + 60000);
    }
    if (code === 'paused' || code === 'not_configured') return t + Math.max(wait, 10 * 60000);
    return t + wait;
  }

  function photoChars(rec) {
    var n = 0;
    if (!rec.payload) return 0;
    ((rec.payload && rec.payload.photos) || []).forEach(function (p) { n += (p.data || '').length; });
    return n;
  }

  // 新しい記録を足せるか。足せないときは理由のコード
  function canAdd(records, rec, now) {
    var open = records.filter(function (r) { return r.state !== 'sent'; });
    if (open.length >= LIMITS.pending) return 'too_many_pending';
    var chars = photoChars(rec);
    open.forEach(function (r) { chars += photoChars(r); });
    if (chars > LIMITS.pendingChars) return 'too_much_data';
    var recent = records.filter(function (r) { var d = now - r.createdAt; return d >= 0 && d < 3600 * 1000; });
    if (recent.length >= LIMITS.hourly) return 'hourly_limit';
    return null;
  }

  // 理由のコード → 本人に見せる文(何が悪いか・どうすればよいか)
  // state = 記録の状態(受付の設定の遅れは、自動で送り直している間 = pending と、使い切った後 = blocked で案内が違う)
  function describe(code, state) {
    var c = String(code || '');
    var field = c.indexOf('bad_field:') === 0 ? c.slice(10) : '';
    var names = { date: '実施日', site: '現場', dept: '部署', company: '会社名', role: '立場', name: '氏名', members: '実施した会社', ref: '控え番号', created: '作成日時', device: '端末の印' };
    var d = {
      too_large: ['送る量が大きすぎて受け付けられませんでした。', '写真の枚数を減らして、はじめから入れ直してください。'],
      photo_size: ['写真が大きすぎて受け付けられませんでした。', '写真の枚数を減らすか撮り直して、はじめから入れ直してください。'],
      photo_count: ['写真の枚数が正しくありません(1〜10 枚)。', '写真を選び直して、はじめから入れ直してください。'],
      photo_type: ['写真の種類が受け付けられませんでした(JPEG か PNG)。', 'カメラで撮り直した写真で、はじめから入れ直してください。'],
      old_page: ['このページの版が古く、受付で受け付けられませんでした。', 'このページを開き直してから、はじめから入れ直してください(この記録は送れないので消してかまいません)。'],
      bad_json: ['送信の形が正しくありませんでした。', 'このページを開き直してから、はじめから入れ直してください。'],
      bad_request: ['送信の形が正しくありませんでした。', 'このページを開き直してから、はじめから入れ直してください。'],
      paused: ['いまは受付を止めています。', 'このままで大丈夫です。受付が再開したら自動で送ります。'],
      not_configured: ['受付の準備ができていません。', 'このままで大丈夫です。準備ができたら自動で送ります。'],
      busy: ['受付が混み合っています。', 'このままで大丈夫です。自動で送り直します。'],
      device_limit: ['この端末からの送信が多すぎます。', 'このままで大丈夫です。しばらくしてから自動で送り直します。'],
      daily_limit: ['受付の上限に達しています。', 'このままで大丈夫です。受け付けられるようになったら自動で送ります(ときどき電波のある所でこのページを開いてください)。'],
      send_failed: ['受付でメールを送れませんでした。', 'このままで大丈夫です。自動で送り直します。'],
      server_error: ['受付で問題が起きました。', 'このままで大丈夫です。自動で送り直します。'],
      network: ['電波が届かず送れていません。', '電波のある所でこのページを開いていれば、自動で送ります。'],
      timeout: ['電波が弱く、送り終わる前に時間切れになりました。', '電波の強い所でこのページを開いていれば、自動で送ります。'],
      future_date: ['実施日が受付の日付(日本時間)より後になっています。', 'このままで大丈夫です。日付が変わったら自動で送ります。'],
      bad_response: ['受付からの返事が読めませんでした。', 'このままで大丈夫です。自動で送り直します。'],
      no_receipt: ['受付番号が返ってきていません。', 'このままで大丈夫です。自動で送り直します。'],
      too_many_pending: ['送れていない・送れないものが多すぎて、この端末に残せません。', '電波のある所でこのページを開き、送れていないものを先に送ってください。消してよいのは、下の「送信の記録」で「送れません」のうち「もう一度送る」が出ていない記録(送り直しても通らないもの)だけです。「もう一度送る」が出ている記録は消さずに先にそれを押し、続くときは配られた説明の紙の連絡先へ。'],
      too_much_data: ['この端末に残せる量を超えます。', '電波のある所でこのページを開き、送れていないものを先に送ってください。'],
      hourly_limit: ['この端末から 1 時間に送れる数(10 件)を超えます。', 'しばらくしてから入れ直してください。']
    };
    // 受付の設定の遅れ(現場・部署・受付の方が古い版)。ページが確かめて作った記録なので、受付が直れば通る
    if (field === 'site' || field === 'dept' || c === 'old_receiver') {
      var what = c === 'old_receiver' ? '受付の版がこのページより古く、まだ受け付けられません。' : '入力の「' + names[field] + '」が受付で受け付けられませんでした(受付の設定がまだ追いついていないことがあります)。';
      return { what: what, fix: state === 'blocked'
        ? '自動の送り直しを続けても通りませんでした。「送信の記録」の「もう一度送る」を押してください。続くときは、配られた説明の紙の連絡先へ(入れ直したり消したりしないでください)。'
        : 'このままで大丈夫です。受付の設定が直ったら自動で送り直します(1〜12 時間ごと)。受付を直したと連絡があれば、「送信の記録」の「今すぐ送る」を押してください。' };
    }
    if (field) return { what: '入力の「' + (names[field] || field) + '」が受け付けられませんでした。', fix: 'はじめから入れ直してください。続くときは、配られた説明の紙の連絡先へ。' };
    var x = d[c] || ['送れませんでした。', 'このままで大丈夫です。自動で送り直します。'];
    return { what: x[0], fix: x[1] };
  }

  /*
   * opts = { store, send, now, onChange }
   *   store: { getAll() → Promise<records>, put(rec) → Promise, remove(id) → Promise }(null = 端末に残せない)
   *   send(payload) → Promise<応答の JSON | {network:true, code}>(reject しない)
   */
  function createOutbox(opts) {
    var store = opts.store || null;
    var now = opts.now || function () { return Date.now(); };
    var onChange = opts.onChange || function () {};
    var records = {};
    var unsaved = {};  // 端末に残せなかった記録の id
    var flushing = null;

    function list() {
      return Object.keys(records).map(function (k) { return records[k]; })
        .sort(function (a, b) { return b.createdAt - a.createdAt; });
    }

    function persist(rec) {
      if (!store) { unsaved[rec.id] = true; return Promise.resolve(false); }
      return store.put(rec).then(function () {
        delete unsaved[rec.id];
        return true;
      }, function () {
        unsaved[rec.id] = true;
        return false;
      });
    }

    // 端末に残した記録を読み込む。読めなかったら reject する(画面で知らせる。黙って空にしない)
    function load() {
      if (!store) return Promise.resolve(list());
      return store.getAll().then(function (rs) {
        var t = now();
        var saving = [];
        (rs || []).forEach(function (r) {
          if (!r || !r.id || records[r.id]) return;
          r.sending = false;
          records[r.id] = r;
          if (clampTimes(r, t)) saving.push(persist(r)); // 縮めた時刻は保存し直す(開くたびに期限が先へずれないように)
        });
        // 保存し直しが終わってから返す(すぐ開き直したときに古い期限を読まないように)
        return Promise.all(saving).then(prune).then(function () { onChange(); return list(); });
      });
    }

    // 端末の時計のずれで未来になった時刻をそろえる。変えたら true(呼んだ側が保存し直す)
    // ・次に送る時刻・保留の期限は、今から 25 時間まで
    // ・作った時刻は、1 時間の数えに入らない過去に(今にそろえると数えに入って新しい送信を止めてしまう)
    // ・送った時刻・前に送った時刻は、今に
    function clampTimes(r, t) {
      var changed = false;
      // 壊れた値(数でない)は 0 にそろえる(タイマーが 0 秒で回り続けないように)
      ['nextAt', 'holdUntil', 'createdAt', 'sentAt', 'lastTriedAt'].forEach(function (k) {
        if (r[k] != null && !isFinite(r[k])) { r[k] = 0; changed = true; }
      });
      if (r.state === 'pending' && r.nextAt > t + MAX_WAIT_MS) { r.nextAt = t + MAX_WAIT_MS; changed = true; }
      if (r.holdUntil > t + MAX_WAIT_MS) { r.holdUntil = t + MAX_WAIT_MS; changed = true; }
      if (r.createdAt > t) { r.createdAt = t - 3600 * 1000 - 1; changed = true; }
      if (r.sentAt > t) { r.sentAt = t; changed = true; }
      if (r.lastTriedAt > t) { r.lastTriedAt = t; changed = true; }
      return changed;
    }

    // 遅れて開いた保存先をつなぐ: 画面に出ている記録を保存し直してから、前に残した記録を読み込む
    function attachStore(s) {
      if (store || !s) return Promise.resolve(false);
      store = s;
      return Promise.all(list().map(function (r) { return persist(r); })).then(function () {
        return load();
      }).then(function () { onChange(); return true; });
    }

    // 送信済みで 7 日を過ぎたものを消す(送れていない・送れない記録は消さない)
    function prune() {
      var t = now();
      var old = list().filter(function (r) { return r.state === 'sent' && t - (r.sentAt || r.createdAt) > LIMITS.sentKeepMs; });
      return Promise.all(old.map(function (r) {
        delete records[r.id];
        return store ? store.remove(r.id).then(null, function () {}) : null;
      }));
    }

    // 戻り値 { added, saved, error }。saved=false = 端末に残せなかった(画面ですぐ知らせる)
    function add(rec) {
      if (records[rec.id]) return Promise.resolve({ added: false, saved: !unsaved[rec.id], error: null });
      var why = canAdd(list(), rec, now());
      if (why) return Promise.resolve({ added: false, saved: false, error: why });
      rec.state = 'pending';
      rec.attempts = 0;
      rec.nextAt = 0;
      rec.lastCode = null;
      records[rec.id] = rec;
      return persist(rec).then(function (saved) {
        onChange();
        return { added: true, saved: saved, error: null };
      });
    }

    // 送れていないものを古い順に 1 件ずつ送る。force = 電波が戻った・ページを開いた。
    // force でも待ち時間を無視するのは、まだ送っていないものと、前回が通信そのものの失敗だったものだけ
    // (1 日の上限・止めている等の受付全体の理由では、決めた時刻まで送らない)
    // firstId = 先に送る記録(いま「送信する」を押したもの)。古い記録の後ろで待たせない
    var again = null; // 送っている間に来た「送って」の頼み(終わったらすぐ続けて送る)
    function flush(force, firstId) {
      if (flushing) {
        again = { force: !!force || !!(again && again.force), firstId: firstId || (again && again.firstId) || null };
        return flushing;
      }
      // 並び: 押した記録 → まだ送っていない・前に送ってから長いものから(同じなら古い順)。
      // 同じ記録が同じ理由で失敗し続けても、後ろの記録が送られなくならないように
      var t0 = now();
      // 開いている間に時計が直った場合も、送る前にそろえて保存し直す
      var saving = [];
      list().forEach(function (r) { if (clampTimes(r, t0)) saving.push(persist(r)); });
      var queue = list().filter(function (r) { return r.state === 'pending'; }).reverse();
      queue.sort(function (a, b) {
        // 時計のずれで未来になった「前に送った時刻」は今として扱う(その記録だけ後回しにならないように)
        return ((b.id === firstId) - (a.id === firstId)) || (Math.min(a.lastTriedAt || 0, t0) - Math.min(b.lastTriedAt || 0, t0));
      });
      flushing = queue.reduce(function (p, rec) {
        return p.then(function (stop) {
          // 送っている間に「送信する」が押されたら、今の 1 件の後はその記録を先に送り直す(残りは続けてその後で)
          if (stop || (again && again.firstId)) return true;
          // ほかの記録の理由(受付全体)で待たされている記録は、その理由が通信の失敗のときだけ待ちを無視してよい
          var heldByService = rec.holdCode && LINK_CODES.indexOf(rec.holdCode) === -1 && rec.holdUntil > now();
          if (heldByService) return false;
          // 時間切れが続いた記録(弱い電波で大きすぎる)は、直前の理由が何であれ待ち時間を守る
          var linkFail = !rec.lastCode || (LINK_CODES.indexOf(rec.lastCode) !== -1 && (rec.timeouts || 0) < TIMEOUTS_BEFORE_BACKOFF);
          if (rec.nextAt > now() && !(force && linkFail)) return false;
          rec.sending = true;
          onChange();
          return Promise.resolve().then(function () { return opts.send(rec.payload); }).then(null, function () { return { network: true, code: 'network' }; }).then(function (res) {
            var c = classify(res, rec.id, rec.payload);
            rec.sending = false;
            rec.attempts += 1;
            rec.lastTriedAt = now();
            rec.holdCode = null;
            rec.holdUntil = 0;
            // 時間切れの回数は、受付まで届いた返事(受付番号・拒否)で 0 に戻す。通信そのものの失敗では戻さない
            // (電波が一瞬切れただけで、大きな記録の送り直しの歯止めが外れないように)
            // 数えるのは時間切れと読めない応答(大きな記録の送信が途中で切れて、受付の代わりのエラーの画面が返る場合など)
            if (c.code === 'timeout' || c.code === 'bad_response') rec.timeouts = (rec.timeouts || 0) + 1;
            else if (['network', 'no_receipt'].indexOf(c.code) === -1) rec.timeouts = 0;
            if (c.state === 'sent') {
              rec.state = 'sent';
              rec.receipt = c.receipt;
              rec.sentAt = now();
              rec.lastCode = null;
              rec.payload = null; // 送れたら中身(写真・会社・氏名)は手放し、一覧の表示(summary)と受付番号だけを残す
            } else if (c.state === 'blocked' && CONFIG_CODES.indexOf(c.code) !== -1 && (rec.configTries || 0) < CONFIG_WAIT_S.length) {
              // 受付の設定の遅れ: 端末に残したまま、間を空けて自動で送り直す(その記録だけ。ほかの記録は待たせない)
              rec.configTries = (rec.configTries || 0) + 1;
              rec.lastCode = c.code;
              rec.nextAt = Math.min(now() + CONFIG_WAIT_S[rec.configTries - 1] * 1000, now() + MAX_WAIT_MS);
            } else if (c.state === 'blocked') {
              rec.state = 'blocked';
              rec.lastCode = c.code;
            } else {
              rec.lastCode = c.code;
              rec.nextAt = Math.min(nextTry(c.code, rec.attempts, now(), c.retryAfterSec), now() + MAX_WAIT_MS);
            }
            // 送れなかった理由が受付全体・通信そのもの(止めている・1 日の上限・電波が無い等)なら、
            // ほかの送れていない記録も同じ時刻まで待たせる(次のタイマーで順に送って同じ理由で断られないように)
            var hold = c.state === 'pending' && PER_RECORD_CODES.indexOf(c.code) === -1;
            var others = [];
            if (hold) {
              list().forEach(function (r) {
                if (r === rec || r.state !== 'pending') return;
                // 保留の理由と期限は、その記録の待ち時間が既に長くても付ける(画面に戻ったときに保留をすり抜けないように)。
                // 受付全体の理由の保留が効いている間は、通信の失敗の保留で上書きしない(保留が弱まらないように)
                var activeService = r.holdCode && LINK_CODES.indexOf(r.holdCode) === -1 && r.holdUntil > now();
                if (!activeService || LINK_CODES.indexOf(c.code) === -1) r.holdCode = c.code;
                r.holdUntil = Math.max(r.holdUntil || 0, rec.nextAt);
                if (!(r.nextAt >= rec.nextAt)) {
                  r.nextAt = rec.nextAt;
                  // その記録だけの理由(時間切れ等)の記録は、理由と時間切れの回数を上書きしない(大きな記録の送り直しの歯止めを保つ)
                  if (PER_RECORD_CODES.indexOf(r.lastCode) === -1) r.lastCode = c.code;
                }
                others.push(r);
              });
            }
            return Promise.all([persist(rec)].concat(others.map(persist))).then(function () {
              onChange();
              // 送れなかったら、残りも同じ理由で通らないので今回はやめる。ただし、その記録だけの理由
              // (時間切れ = 大きな記録で起きやすい・実施日が明日)のときは、後ろの記録を続けて送る
              return hold;
            });
          });
        });
      }, Promise.all(saving).then(function () { return false; })).then(function () {
        return prune();
      }).then(function () {
        flushing = null;
        onChange();
      }, function () {
        flushing = null;
      }).then(function () {
        // 送っている間に「送信する」が押された・電波が戻った等なら、続けてもう 1 回
        if (again) {
          var a = again;
          again = null;
          return flush(a.force, a.firstId);
        }
        return list();
      });
      return flushing;
    }

    // 「送れません」のうち、受付の設定の遅れで起きるもの(現場・部署・受付の方が古い版)は、自動の送り直しを
    // 使い切った後も本人がもう一度送れる。中身はそのまま送り直す(版を当てない。D40 ④)。
    // ページの方が古い版の拒否(old_page)は送り直しても通らないので出さない
    function canRetry(id) {
      var r = records[id];
      return !!r && r.state === 'blocked' && CONFIG_CODES.indexOf(r.lastCode) !== -1 && !!r.payload;
    }
    function retry(id) {
      if (!canRetry(id)) return Promise.resolve(false);
      var r = records[id];
      r.configTries = 0;
      r.state = 'pending';
      r.attempts = 0;
      r.nextAt = 0;
      r.lastCode = null;
      r.holdCode = null;
      r.holdUntil = 0;
      r.timeouts = 0;
      return persist(r).then(function () { onChange(); return true; });
    }

    // 受付の設定の遅れで自動の送り直しを待っている記録は、本人が「今すぐ送る」で待ちを飛ばせる
    // (受付を直したと連絡を受けたとき)。自動の回数(configTries)は戻さないので、押し続けても通信量は増え続けない。
    // 受付全体の理由(止めている・1 日の上限)で待たされている間は出さない(D41。User 裁定 9/29)
    function canSendNow(id) {
      var r = records[id];
      if (!r || r.state !== 'pending' || r.sending || CONFIG_CODES.indexOf(r.lastCode) === -1 || !r.payload) return false;
      var heldByService = r.holdCode && LINK_CODES.indexOf(r.holdCode) === -1 && r.holdUntil > now();
      return !heldByService;
    }
    function sendNow(id) {
      if (!canSendNow(id)) return Promise.resolve(false);
      var r = records[id];
      r.nextAt = 0;
      return persist(r).then(function () { onChange(); return true; });
    }

    // 送れない記録を消す(本人が選んだときだけ)。送れていない記録は消さない。
    // 端末から消せたときだけ一覧から外す(消せなかったのに消えたように見せない)
    function remove(id) {
      var rec = records[id];
      if (!rec || rec.state !== 'blocked') return Promise.resolve(false);
      var gone = store ? store.remove(id).then(function () { return true; }, function () { return false; }) : Promise.resolve(true);
      return gone.then(function (ok) {
        if (ok) {
          delete records[id];
          delete unsaved[id];
        }
        onChange();
        return ok;
      });
    }

    function status() {
      // 残せなかったものは、まだ送れていない記録だけを数える(送れた記録・送れない記録は、閉じて消えても送り直しに影響しない)
      var s = { pending: 0, blocked: 0, sent: 0, unsaved: Object.keys(unsaved).filter(function (id) { return records[id] && records[id].state === 'pending'; }).length, sending: false };
      list().forEach(function (r) { s[r.state] += 1; if (r.sending) s.sending = true; });
      return s;
    }

    // 次に送り直す時刻(送れていないものが無ければ null)
    function nextDue() {
      var t = null;
      list().forEach(function (r) {
        if (r.state !== 'pending') return;
        // ほかの記録の理由(受付全体)で保留中なら、その期限まで(タイマーが何もせずに回らないように)
        var due = (r.holdCode && LINK_CODES.indexOf(r.holdCode) === -1) ? Math.max(r.nextAt, r.holdUntil || 0) : r.nextAt;
        due = Math.min(due, now() + MAX_WAIT_MS);
        if (t === null || due < t) t = due;
      });
      return t;
    }

    // その記録が端末に残せていないか(完了画面で、この送信について正しく知らせるため)
    function isUnsaved(id) {
      return !!unsaved[id] && !!records[id] && records[id].state === 'pending';
    }

    return { load: load, attachStore: attachStore, add: add, flush: flush, remove: remove, retry: retry, canRetry: canRetry, sendNow: sendNow, canSendNow: canSendNow, list: list, status: status, nextDue: nextDue, isUnsaved: isUnsaved, get: function (id) { return records[id] || null; } };
  }

  /*
   * 自動で送り直すきっかけをつなぐ: 電波が戻った(online)・ページを開いた(pageshow)・画面に戻った(visibilitychange)
   * と、開いている間のタイマー(次に送る時刻まで。最短 5 秒)
   */
  function startAutoRetry(env) {
    var win = env.win, doc = env.doc, outbox = env.outbox;
    var setT = env.setTimeout || root.setTimeout, clearT = env.clearTimeout || root.clearTimeout;
    var now = env.now || function () { return Date.now(); };
    var timer = null;
    function schedule() {
      if (timer) clearT(timer);
      timer = null;
      var due = outbox.nextDue();
      if (due === null) return;
      timer = setT(function () { run(false); }, Math.min(Math.max(5000, due - now()), 3600 * 1000));
    }
    function run(force, firstId) {
      return outbox.flush(force, firstId).then(schedule, schedule);
    }
    win.addEventListener('online', function () { run(true); });
    win.addEventListener('pageshow', function () { run(true); });
    if (doc) {
      doc.addEventListener('visibilitychange', function () {
        if (doc.visibilityState === 'visible') run(true);
      });
    }
    return { run: run };
  }

  // IndexedDB の保存先。開けない端末(プライベートブラウズ等)では reject する
  function createIdbStore(idb) {
    var DB = 'patrol-outbox', OS = 'records';
    return new Promise(function (resolve, reject) {
      if (!idb) { reject(new Error('no_idb')); return; }
      var req;
      try { req = idb.open(DB, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = function () { req.result.createObjectStore(OS, { keyPath: 'id' }); };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { reject(new Error('blocked')); };
      req.onsuccess = function () {
        var db = req.result;
        function tx(mode, fn) {
          return new Promise(function (ok, ng) {
            var t;
            try { t = db.transaction(OS, mode); } catch (e) { ng(e); return; }
            var r = fn(t.objectStore(OS));
            t.oncomplete = function () { ok(r && r.result); };
            t.onerror = function () { ng(t.error); };
            t.onabort = function () { ng(t.error || new Error('abort')); };
          });
        }
        resolve({
          getAll: function () { return tx('readonly', function (s) { return s.getAll(); }); },
          put: function (rec) { return tx('readwrite', function (s) { return s.put(rec); }); },
          remove: function (id) { return tx('readwrite', function (s) { return s.delete(id); }); }
        });
      };
    });
  }

  var Outbox = {
    LIMITS: LIMITS,
    classify: classify,
    backoffMs: backoffMs,
    nextTry: nextTry,
    canAdd: canAdd,
    describe: describe,
    createOutbox: createOutbox,
    startAutoRetry: startAutoRetry,
    createIdbStore: createIdbStore
  };

  root.PatrolOutbox = Outbox;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Outbox;
  }
})(typeof window !== 'undefined' ? window : globalThis);
