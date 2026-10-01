/*
 * 設定はこのファイル 1 か所だけ。差し替えるときはここだけを直す。
 * - 仮の値は TEST- で始まる架空名だけ。
 * - 部署・現場は名前を書かず、コードだけを書く(名前との対応は非公開側で持つ)。
 * - 会社の一覧はデータファイル roster.js に分けてある(後の便で自動生成するため)。
 * - 受け口のメールアドレスはここに書かない(受付 = Google Apps Script の設定にだけある)。
 * - 現場コードを変えたら、受付のコード gas-intake/Code.js の SITES も同じ値にする。
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

    // 受付(Google Apps Script の web app)の URL。User が設置したデプロイ「受付 v1」(2026-10-01)の URL。
    // 受付の更新は既存のデプロイの編集で行い、この URL を変えない(docs/patrol-intake/gas-setup-guide.md)
    endpoint: 'https://script.google.com/macros/s/AKfycbwk64H-ZWNE7nCq3-b7G77UYvHb28lk55fbvRk6qgTsi9bHtBQCKgJRiEbZciKEWuHM7A/exec',

    // 実施者の選択肢(会社)は別のデータファイル roster.js(現場ごと)

    // 現場コードと、その現場が属する部署コード
    sites: [
      { code: 'TEST-S01', dept: 'TEST-D1' },
      { code: 'TEST-S02', dept: 'TEST-D1' },
      { code: 'TEST-S03', dept: 'TEST-D1' }
    ]
  };

  root.PATROL_CONFIG = PATROL_CONFIG;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PATROL_CONFIG;
  }
})(typeof window !== 'undefined' ? window : globalThis);
