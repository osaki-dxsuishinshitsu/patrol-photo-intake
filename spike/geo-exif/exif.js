// 試しのページ: ファイルの形式の判定と、JPEG の EXIF の撮影日時の読み取り(仕様 job-20261030-001)。
// 外部のライブラリを使わない自前の小さな読み取り。ブラウザでは window.GeoExif、node では module.exports。
// 位置情報(GPS)は有無だけを返し、値は読まない。
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.GeoExif = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TAG_EXIF_IFD = 0x8769;
  var TAG_GPS_IFD = 0x8825;
  var TAG_DATE_TIME_ORIGINAL = 0x9003;
  var TAG_OFFSET_TIME_ORIGINAL = 0x9011;
  var TYPE_ASCII = 2;
  var HEIF_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'heif'];

  // 読みが範囲の外へ出たときの印。classify で「壊れている」に変える。
  function Broken(why) { this.why = why; }

  function ascii(bytes, start, len) {
    var s = '';
    for (var i = start; i < start + len && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  // 先頭のバイトで形式を決める: 'JPEG' / 'HEIC' / 'PNG' / 'PDF' / 'そのほか'。
  function detectFormat(bytes) {
    var b = bytes || [];
    if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'JPEG';
    if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && b[4] === 0x0D && b[5] === 0x0A) return 'PNG';
    if (b.length >= 5 && ascii(b, 0, 5) === '%PDF-') return 'PDF';
    if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp' && HEIF_BRANDS.indexOf(ascii(b, 8, 4)) >= 0) return 'HEIC';
    return 'そのほか';
  }

  // TIFF(EXIF の本体)を読む。start = TIFF の頭、end = APP1 の終わり。オフセットはすべて TIFF の頭から。
  function readTiff(bytes, start, end) {
    function need(off, len) {
      if (off < 0 || start + off + len > end) throw new Broken('範囲の外');
    }
    need(0, 8);
    var order = ascii(bytes, start, 2);
    var le;
    if (order === 'II') le = true;
    else if (order === 'MM') le = false;
    else throw new Broken('バイト順の印が無い');
    function u16(off) {
      need(off, 2);
      var a = bytes[start + off], b = bytes[start + off + 1];
      return le ? (a | (b << 8)) : ((a << 8) | b);
    }
    function u32(off) {
      need(off, 4);
      var p = start + off;
      var v = le
        ? (bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24))
        : ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]);
      return v >>> 0;
    }
    if (u16(2) !== 42) throw new Broken('TIFF の印が無い');

    // IFD の項目を { tag: 項目の位置 } にする。
    function entries(ifdOff) {
      var n = u16(ifdOff);
      need(ifdOff + 2, n * 12);
      var map = {};
      for (var i = 0; i < n; i++) {
        var e = ifdOff + 2 + i * 12;
        map[u16(e)] = e;
      }
      return map;
    }
    function asciiValue(entryOff) {
      if (u16(entryOff + 2) !== TYPE_ASCII) return null;
      var count = u32(entryOff + 4);
      var dataOff = count <= 4 ? entryOff + 8 : u32(entryOff + 8);
      need(dataOff, count);
      var s = ascii(bytes, start + dataOff, count).replace(/\0+$/, '').trim();
      return s === '' ? null : s;
    }

    var ifd0 = entries(u32(4));
    var out = { hasGps: Object.prototype.hasOwnProperty.call(ifd0, TAG_GPS_IFD), dateTimeOriginal: null, offsetTimeOriginal: null };
    if (Object.prototype.hasOwnProperty.call(ifd0, TAG_EXIF_IFD)) {
      var exif = entries(u32(ifd0[TAG_EXIF_IFD] + 8));
      if (Object.prototype.hasOwnProperty.call(exif, TAG_DATE_TIME_ORIGINAL)) out.dateTimeOriginal = asciiValue(exif[TAG_DATE_TIME_ORIGINAL]);
      if (Object.prototype.hasOwnProperty.call(exif, TAG_OFFSET_TIME_ORIGINAL)) out.offsetTimeOriginal = asciiValue(exif[TAG_OFFSET_TIME_ORIGINAL]);
    }
    return out;
  }

  // JPEG のマーカーを順にたどって APP1 の Exif を探す。
  // 返り値の status: 'ok'(撮影日時あり)/ 'noDate'(EXIF はあるが撮影日時なし)/ 'noExif' / 'broken'。
  // partial = true はファイルの先頭だけを渡したとき。区間が渡した範囲の外へ出たら壊れではなく「先頭に無い」とする。
  function readJpegExif(bytes, partial) {
    var off = 2;
    try {
      while (off + 4 <= bytes.length) {
        if (bytes[off] !== 0xFF) throw new Broken('マーカーが無い');
        var marker = bytes[off + 1];
        if (marker === 0xFF) { off += 1; continue; }
        if (marker === 0xD9 || marker === 0xDA) break; // 画像の終わり・画像のデータの始まり(この先に EXIF は無い)
        if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { off += 2; continue; }
        var segLen = (bytes[off + 2] << 8) | bytes[off + 3];
        if (segLen < 2) throw new Broken('区間の長さが合わない');
        if (off + 2 + segLen > bytes.length) {
          if (partial) return { status: 'noExif', why: 'head', dateTimeOriginal: null, offsetTimeOriginal: null, hasGps: null };
          throw new Broken('区間の長さが合わない');
        }
        if (marker === 0xE1 && segLen >= 8 && ascii(bytes, off + 4, 6) === 'Exif\0\0') {
          var t = readTiff(bytes, off + 10, off + 2 + segLen);
          return { status: t.dateTimeOriginal ? 'ok' : 'noDate', dateTimeOriginal: t.dateTimeOriginal, offsetTimeOriginal: t.offsetTimeOriginal, hasGps: t.hasGps };
        }
        off += 2 + segLen;
      }
      return { status: 'noExif', dateTimeOriginal: null, offsetTimeOriginal: null, hasGps: false };
    } catch (e) {
      if (e instanceof Broken) return { status: 'broken', why: e.why, dateTimeOriginal: null, offsetTimeOriginal: null, hasGps: null };
      throw e;
    }
  }

  var REASON = { noExif: 'EXIF なし', noDate: 'EXIF はあるが撮影日時のタグなし', broken: '壊れている・読めない' };

  // 3 区分: 'present'(あり)/ 'jpegNoDate'(JPEG だが撮影日時が無い)/ 'notJpeg'(JPEG 以外なので読んでいない)。
  function classify(bytes, partial) {
    var format = detectFormat(bytes);
    if (format !== 'JPEG') {
      return { format: format, category: 'notJpeg', label: 'JPEG 以外なので読んでいない(' + format + ')', gpsLabel: '読んでいない', dateTimeOriginal: null, offsetTimeOriginal: null, hasGps: null };
    }
    var r = readJpegExif(bytes, partial);
    var gpsLabel = r.hasGps === null ? '不明(読めない)' : (r.hasGps ? 'あり' : 'なし');
    if (r.status === 'ok') {
      return {
        format: format, category: 'present',
        label: 'あり: ' + r.dateTimeOriginal + ' ' + (r.offsetTimeOriginal || '(OffsetTimeOriginal なし)'),
        gpsLabel: gpsLabel, dateTimeOriginal: r.dateTimeOriginal, offsetTimeOriginal: r.offsetTimeOriginal, hasGps: r.hasGps
      };
    }
    return {
      format: format, category: 'jpegNoDate', reason: r.status,
      label: 'JPEG だが撮影日時が無い(' + (r.why === 'head' ? '先頭の読んだ範囲に EXIF なし' : REASON[r.status]) + ')',
      gpsLabel: gpsLabel, dateTimeOriginal: null, offsetTimeOriginal: r.offsetTimeOriginal || null, hasGps: r.hasGps
    };
  }

  return { detectFormat: detectFormat, readJpegExif: readJpegExif, classify: classify };
});
