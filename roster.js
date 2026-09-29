/*
 * 実施者(会社)の一覧 — データだけのファイル(ページの本体とは別)。
 * 自動で作ることもある。手で直すときもこの形を守る。
 *
 * 1 行 = { site: 現場コード, company: 会社名 }。ページが使うのはこの 2 項目だけ(ほかの項目があると止まる)。
 * - 現場名・部署名・人名は書かない(現場はコードだけ)。
 * - 会社名に ; = と改行は使えず、先頭に = + - @ は使えない(メール本文の区切り・表計算の式になるため)。
 * - 並び順がページの表示順になる。
 * - 仮の値は TEST- で始まる架空名だけ。
 */
(function (root) {
  'use strict';

  var PATROL_ROSTER = [
    { site: 'TEST-S01', company: 'TEST-協力会社A' },
    { site: 'TEST-S01', company: 'TEST-協力会社B' },
    { site: 'TEST-S01', company: 'TEST-協力会社C' },
    { site: 'TEST-S02', company: 'TEST-協力会社A' },
    { site: 'TEST-S02', company: 'TEST-協力会社C' },
    { site: 'TEST-S03', company: 'TEST-協力会社B' },
    { site: 'TEST-S03', company: 'TEST-協力会社D' }
  ];

  root.PATROL_ROSTER = PATROL_ROSTER;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PATROL_ROSTER;
  }
})(typeof window !== 'undefined' ? window : globalThis);
