/* =============================================================
   んだばい 予約管理バックエンド (Google Apps Script)
   - プログラム別シートへ記録（田村市予約 / 葛尾村予約）
   - Google Calendar にイベント作成
   - 顧客・管理者へメール送信
   - 月次で売上集計（コミッション10%）
   ============================================================= */

// ===== CONFIG — ここを必ず編集してください =====
// 空の場合はコンテナバインドのスプレッドシートを使用します。
// スタンドアロンの場合はスプレッドシートIDを設定してください。
var SPREADSHEET_ID = '1_uyJhhnlsiBGBnNwzhQ9frIOfQfrDZ3uFpAshp3nkkE';
var ADMIN_EMAIL    = 'info@ndanda.net';
var BUSINESS_NAME  = 'んだばい / ndanda合同会社';
var CALENDAR_ID    = ''; // 空ならデフォルトカレンダー
// ================================================

var SHEET_HEADERS = [
  '受付日時', 'プログラム', 'コース', '人数', '希望日',
  'オプション', '合計金額', '氏名', 'メール', '電話',
  '健康状態', '備考', 'ステータス'
];
var SALES_HEADERS = ['月', '田村市売上', '葛尾村売上', '合計', 'コミッション(10%)'];

var PROGRAM_LABEL = { tamura: '田村市', katsurao: '葛尾村' };
var PROGRAM_SHEET = { tamura: '田村市予約', katsurao: '葛尾村予約' };

// ---- エントリポイント -------------------------------------------------

function doGet(e) {
  return jsonOutput({ status: 'ok' });
}

// CORSプリフライト対策（フロントは単純POSTのため通常は不要）
function doOptions(e) {
  return ContentService.createTextOutput('').setMimeType(ContentService.MimeType.TEXT);
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonOutput({ status: 'error', message: 'リクエストボディが空です。' });
    }

    var data = JSON.parse(e.postData.contents);

    // 必須チェック
    var required = { name: 'お名前', email: 'メール', phone: '電話', course: 'コース', date: '希望日' };
    for (var k in required) {
      if (!data[k] || String(data[k]).trim() === '') {
        return jsonOutput({ status: 'error', message: required[k] + ' は必須です。' });
      }
    }

    var program = data.program || 'unknown';
    var optionsText = Array.isArray(data.options) ? data.options.join('、') : (data.options || '');

    // 1. シートへ記録
    var sheetName = PROGRAM_SHEET[program] || 'その他予約';
    var sheet = getOrCreateSheet(sheetName, SHEET_HEADERS);
    sheet.appendRow([
      formatJst(new Date()),
      PROGRAM_LABEL[program] || program,
      data.course || '',
      data.guests || '',
      data.date || '',
      optionsText,
      Number(data.total) || 0,
      data.name || '',
      data.email || '',
      data.phone || '',
      data.health || '',
      data.note || '',
      '新規'
    ]);

    // 2. カレンダーにイベント作成
    try {
      createBookingEvent(data, program);
    } catch (calErr) {
      Logger.log('Calendar error: ' + calErr.message);
    }

    // 3. 顧客へ確認メール
    MailApp.sendEmail({
      to: data.email,
      subject: '【んだばい】ご予約リクエストを受け付けました',
      htmlBody: createConfirmationEmail(data, program)
    });

    // 4. 管理者へ通知メール
    MailApp.sendEmail({
      to: ADMIN_EMAIL,
      subject: '【新規予約】' + (data.name || '') + ' / ' + (data.course || ''),
      htmlBody: createAdminNotification(data, program)
    });

    return jsonOutput({ status: 'success', message: '予約を受け付けました' });

  } catch (err) {
    Logger.log('doPost error: ' + err.message);
    return jsonOutput({ status: 'error', message: err.message });
  }
}

// ---- ヘルパー -------------------------------------------------------

function getSpreadsheet() {
  if (SPREADSHEET_ID) return SpreadsheetApp.openById(SPREADSHEET_ID);
  return SpreadsheetApp.getActiveSpreadsheet();
}

function getOrCreateSheet(name, headers) {
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function formatJst(d) {
  return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
}

function getCalendar() {
  if (CALENDAR_ID) {
    var c = CalendarApp.getCalendarById(CALENDAR_ID);
    if (c) return c;
  }
  return CalendarApp.getDefaultCalendar();
}

function createBookingEvent(data, program) {
  if (!data.date) return;
  var start = new Date(data.date + 'T12:00:00+09:00');
  if (isNaN(start.getTime())) return;
  var end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  var title = '【予約】' + (data.name || '') + ' / ' + (PROGRAM_LABEL[program] || program) + ' ' + (data.course || '');
  getCalendar().createEvent(title, start, end, {
    description: JSON.stringify(data, null, 2)
  });
}

function jsonOutput(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---- メールテンプレート --------------------------------------------

function createConfirmationEmail(data, program) {
  var label = PROGRAM_LABEL[program] || program;
  var opts = Array.isArray(data.options) ? (data.options.join('、') || 'なし') : (data.options || 'なし');
  return [
    '<div style="font-family:sans-serif;color:#3a2e1f;line-height:1.8">',
    '<p>' + esc(data.name) + ' 様</p>',
    '<p>この度は「んだばい 滞在型ファスティング・ウェルネス」にご興味をお持ちいただき、誠にありがとうございます。<br>ご予約リクエストを受け付けました。</p>',
    '<table style="border-collapse:collapse;margin:16px 0;font-size:14px">',
    row('プログラム', label),
    row('コース', data.course),
    row('希望日', data.date),
    row('人数', (data.guests || '') + '名'),
    row('オプション', opts),
    row('合計金額', yen(data.total)),
    '</table>',
    '<p>スタッフより<strong>24時間以内</strong>に正式な確認のご連絡を差し上げます。今しばらくお待ちください。</p>',
    '<p style="font-size:13px;color:#8a7a63">【キャンセルポリシー】7日前まで無料／3〜6日前 50%／前日 80%／当日・無断 100%</p>',
    '<hr style="border:none;border-top:1px solid #e6ddcd">',
    '<p style="font-size:13px">' + esc(BUSINESS_NAME) + '<br>お問い合わせ: ' + esc(ADMIN_EMAIL) + '</p>',
    '<p style="font-size:11px;color:#aaa">※ このメールは自動送信です。</p>',
    '</div>'
  ].join('');
}

function createAdminNotification(data, program) {
  var label = PROGRAM_LABEL[program] || program;
  var opts = Array.isArray(data.options) ? (data.options.join('、') || 'なし') : (data.options || 'なし');
  var ssUrl = '';
  try { ssUrl = getSpreadsheet().getUrl(); } catch (e) {}
  return [
    '<div style="font-family:sans-serif;color:#3a2e1f;line-height:1.8">',
    '<p><strong>新規予約リクエストが届きました。</strong></p>',
    '<table style="border-collapse:collapse;margin:12px 0;font-size:14px">',
    row('受付日時', formatJst(new Date())),
    row('プログラム', label),
    row('コース', data.course),
    row('希望日', data.date),
    row('人数', (data.guests || '') + '名'),
    row('オプション', opts),
    row('合計金額', yen(data.total)),
    row('お名前', data.name),
    row('メール', data.email),
    row('電話', data.phone),
    row('健康状態', data.health || '—'),
    row('備考', data.note || '—'),
    '</table>',
    ssUrl ? '<p><a href="' + ssUrl + '">▶ スプレッドシートで確認する</a></p>' : '',
    '<p style="color:#c75c2a">※ 24時間以内に確認連絡の対応をお願いします。</p>',
    '</div>'
  ].join('');
}

function row(label, value) {
  return '<tr><th style="text-align:left;padding:6px 14px;background:#f3ebe0;border:1px solid #e6ddcd;white-space:nowrap">' +
    esc(label) + '</th><td style="padding:6px 14px;border:1px solid #e6ddcd">' + esc(value) + '</td></tr>';
}

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function yen(n) {
  var num = Number(n) || 0;
  return '¥' + num.toLocaleString('ja-JP');
}

// ---- 月次売上集計（時間主導トリガーで実行） ------------------------

function updateMonthlySales() {
  var ss = getSpreadsheet();
  var now = new Date();
  var monthKey = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM');

  var tamura   = sumMonthlySales(ss.getSheetByName(PROGRAM_SHEET.tamura), monthKey);
  var katsurao = sumMonthlySales(ss.getSheetByName(PROGRAM_SHEET.katsurao), monthKey);
  var total = tamura + katsurao;
  var commission = Math.round(total * 0.1);

  var salesSheet = getOrCreateSheet('売上集計', SALES_HEADERS);
  upsertSalesRow(salesSheet, monthKey, [monthKey, tamura, katsurao, total, commission]);
}

function sumMonthlySales(sheet, monthKey) {
  if (!sheet) return 0;
  var values = sheet.getDataRange().getValues();
  var sum = 0;
  // 受付日時=col0, 合計金額=col6（SHEET_HEADERS準拠）
  for (var i = 1; i < values.length; i++) {
    var ts = values[i][0];
    var amount = Number(values[i][6]) || 0;
    var key = '';
    if (ts instanceof Date) {
      key = Utilities.formatDate(ts, 'Asia/Tokyo', 'yyyy-MM');
    } else if (ts) {
      key = String(ts).slice(0, 7).replace('/', '-'); // "yyyy/MM/dd HH:mm" → "yyyy-MM"
    }
    if (key === monthKey) sum += amount;
  }
  return sum;
}

function upsertSalesRow(sheet, monthKey, rowValues) {
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]) === monthKey) {
      sheet.getRange(i + 1, 1, 1, rowValues.length).setValues([rowValues]);
      return;
    }
  }
  sheet.appendRow(rowValues);
}

// 初回に手動実行して月次トリガーを登録するヘルパー
function setupMonthlyTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'updateMonthlySales') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('updateMonthlySales')
    .timeBased().onMonthDay(1).atHour(2).create();
}
