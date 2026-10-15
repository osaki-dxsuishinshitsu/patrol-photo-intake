/*
 * 設定はこのファイル 1 か所だけ。差し替えるときはここだけを直す。
 * - 現場コード・部署コードは英数字と - だけ(名前やその略称をコードにしない)。
 * - 部署・現場は名前を書かず、コードだけを書く(名前との対応は非公開側で持つ)。
 * - 会社の一覧はデータファイル roster.js に分けてある(後の便で自動生成するため)。
 * - 受け口のメールアドレスはここに書かない(受付 = Google Apps Script の設定にだけある)。
 * - ここの現場はすべて受付のコード gas-intake/Code.js の SITES にあり、部署も同じにする。現場を足すときは受付が先・
 *   外すときはこのファイルが先(受付の方が多い時期がある。仕様 D38・D70)。
 */
(function (root) {
  'use strict';

  var PATROL_CONFIG = {
    // 件名の識別子と本文の書式の版(識別子の台帳に登録したもの)
    formId: 'PTRL-PHOTO',
    formVersion: 2,

    // 実施した人の立場(会社ごとに 1 つ選ぶ)。otherRole のときだけ氏名を入力する
    roles: ['代表者', '安全衛生責任者', 'その他'],
    otherRole: 'その他',

    // 社員が「自分が実施」を選んだときの会社の文字(実在の社名ではない固定の文字。編成表からは取らない)。
    // roster.js の全現場に同じ文字の行が要る(会社を選ぶ欄には出さない。仕様 D52)
    ownCompany: '自社',

    // 受付(Google Apps Script の web app)の URL。User が設置したデプロイ「受付 v1」(2026-10-01)の URL。
    // 受付の更新は既存のデプロイの編集で行い、この URL を変えない(docs/patrol-intake/gas-setup-guide.md)
    endpoint: 'https://script.google.com/macros/s/AKfycbwk64H-ZWNE7nCq3-b7G77UYvHb28lk55fbvRk6qgTsi9bHtBQCKgJRiEbZciKEWuHM7A/exec',

    // 実施者の選択肢(会社)は別のデータファイル roster.js(現場ごと)

    // 現場コードと、その現場が属する部署コード
    sites: [
      { code: 'P-01', dept: 'B-1' },
      { code: 'P-02', dept: 'B-1' },
      { code: 'P-03', dept: 'B-2' },
      { code: 'P-04', dept: 'B-2' }
    ]
  };

  root.PATROL_CONFIG = PATROL_CONFIG;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PATROL_CONFIG;
  }
})(typeof window !== 'undefined' ? window : globalThis);
