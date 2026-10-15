/*
 * 実施者(会社)の一覧 — データだけのファイル(ページの本体とは別)。
 * 自動で作ることもある。手で直すときもこの形を守る。
 *
 * 1 行 = { site: 現場コード, company: 会社名 }。ページが使うのはこの 2 項目だけ(ほかの項目があると止まる)。
 * - 現場名・部署名・人名は書かない(現場はコードだけ)。
 * - 会社名に ; = と改行は使えず、先頭に = + - @ は使えない(メール本文の区切り・表計算の式になるため)。
 * - 並び順がページの表示順になる。
 * - どの現場にも config.js の ownCompany と同じ文字の行が 1 つ要る。協力会社の無い現場は、その 1 行だけでよい(仕様 D52・D71)。
 */
(function (root) {
  'use strict';

  var PATROL_ROSTER = [
    { site: 'P-01', company: '自社' },
    { site: 'P-02', company: '自社' },
    { site: 'P-03', company: '自社' },
    { site: 'P-04', company: '自社' }
  ];

  root.PATROL_ROSTER = PATROL_ROSTER;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PATROL_ROSTER;
  }
})(typeof window !== 'undefined' ? window : globalThis);
