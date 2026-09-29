/*
 * 設定はこのファイル 1 か所だけ。差し替えるときはここだけを直す。
 * - 仮の値は TEST- で始まる架空名と @example.invalid の仮アドレスだけ。
 * - 部署・現場は名前を書かず、コードだけを書く(名前との対応は非公開側で持つ)。
 * - 会社の一覧はデータファイル roster.js に分けてある(後の便で自動生成するため)。
 */
(function (root) {
  'use strict';

  var PATROL_CONFIG = {
    // 件名の識別子と本文の書式の版(識別子の台帳に登録したもの)
    formId: 'PTRL-PHOTO',
    formVersion: 1,

    // 受け口 = 試行用の共有メールボックス 1 件
    mailbox: 'patrol-intake@example.invalid',

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
