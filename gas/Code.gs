/* =============================================================
   んだばい 予約 + 決済バックエンド (Google Apps Script)
   - Stripe Checkout セッション作成（秘密鍵は Script Properties に保管）
   - 決済成功時にスプレッドシート記録 / カレンダー登録 / メール送信
   - プログラム別シート（田村市予約 / 葛尾村予約）
   - 月次で売上集計（コミッション10%）
   ============================================================= */

// ===== CONFIG — ここを必ず編集してください =====
// 空の場合はコンテナバインドのスプレッドシートを使用します。
var SPREADSHEET_ID = '1_uyJhhnlsiBGBnNwzhQ9frIOfQfrDZ3uFpAshp3nkkE';
var ADMIN_EMAIL    = 'info@ndanda.net';
var BUSINESS_NAME  = 'んだばい / ndanda合同会社';
var CALENDAR_ID    = ''; // 空ならデフォルトカレンダー
// Stripe 秘密鍵は「プロジェクトの設定 → スクリプト プロパティ」に
//   キー: STRIPE_SECRET_KEY  値: sk_test_xxx（本番は sk_live_xxx）
// として保存してください（コードに直書きしない）。
// ================================================

var SHEET_HEADERS = [
  '受付日時', 'プログラム', 'コース', '人数', '希望日',
  'オプション', '合計金額', '氏名', 'メール', '電話',
  '健康状態', '備考', 'ステータス', 'StripeセッションID'
];
var SALES_HEADERS = ['月', '売上合計', 'コミッション(10%)'];

// おまかせ（運営が田村/葛尾を割当）に統合。tamura/katsurao は後方互換で残置。
var PROGRAM_LABEL = { omakase: 'おまかせ（田村/葛尾）', tamura: '田村市', katsurao: '葛尾村' };
var PROGRAM_SHEET = { omakase: 'ファスティング予約', tamura: '田村市予約', katsurao: '葛尾村予約' };

var STATUS_PENDING = '決済待ち';
var STATUS_PAID    = '決済済み';

var COL = { // 0-based 列インデックス（SHEET_HEADERS準拠）
  ts:0, program:1, course:2, guests:3, date:4, options:5, total:6,
  name:7, email:8, phone:9, health:10, note:11, status:12, session:13
};

var STRIPE_API = 'https://api.stripe.com/v1';

// ---- エントリポイント -------------------------------------------------

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.action === 'confirm' && p.session_id) {
    return renderResultPage(finalizePayment(p.session_id));
  }
  return jsonOutput({ status: 'ok' });
}

function doPost(e) {
  try {
    var p = (e && e.parameter) || {};

    // (1) フロントの予約フォーム（隠しフォームPOST）→ Checkout を作成しリダイレクト
    if (p.action === 'checkout') {
      return handleCheckout(p);
    }

    // (2) 旧クライアント互換: JSON ボディの直接予約（決済なし・即記録）
    if (e && e.postData && e.postData.contents) {
      var data = JSON.parse(e.postData.contents);
      // Stripe Webイベント（任意・バックアップ）
      if (data && data.type && data.data && data.data.object) {
        var obj = data.data.object;
        if (data.type === 'checkout.session.completed' && obj.id) {
          finalizePayment(obj.id);
        }
        return jsonOutput({ status: 'ok' });
      }
      return legacyRecord(data); // 後方互換
    }

    return jsonOutput({ status: 'error', message: 'リクエストが不正です。' });
  } catch (err) {
    Logger.log('doPost error: ' + err.message);
    return jsonOutput({ status: 'error', message: err.message });
  }
}

// ---- 決済（Stripe Checkout） ---------------------------------------

function handleCheckout(p) {
  var secret = stripeSecret();
  if (!secret) {
    return htmlPage('設定エラー',
      '<p>Stripe 秘密鍵が未設定です。スクリプト プロパティ <b>STRIPE_SECRET_KEY</b> を設定してください。</p>');
  }

  // 必須チェック
  var required = { name: 'お名前', email: 'メール', phone: '電話', course: 'コース', date: '希望日' };
  for (var k in required) {
    if (!p[k] || String(p[k]).trim() === '') {
      return htmlPage('入力エラー', '<p>' + required[k] + ' は必須です。前の画面に戻って入力してください。</p>');
    }
  }

  var program     = p.program || 'unknown';
  var course      = p.course || '';
  var price       = toInt(p.price);
  var guests      = Math.max(1, toInt(p.guests) || 1);
  var optionsText = p.options || '';
  var optionsTot  = toInt(p.optionsTotal);
  var total       = toInt(p.total) || (price * guests + optionsTot);

  var webUrl    = ScriptApp.getService().getUrl();
  var successUrl = webUrl + '?action=confirm&session_id={CHECKOUT_SESSION_ID}';
  var pageUrl   = p.page_url || '';
  var cancelUrl = pageUrl ? (pageUrl + (pageUrl.indexOf('?') >= 0 ? '&' : '?') + 'canceled=1')
                          : (webUrl + '?action=canceled');

  // Stripe パラメータ（application/x-www-form-urlencoded）
  var params = {
    'mode': 'payment',
    'locale': 'ja',
    'customer_email': p.email,
    'success_url': successUrl,
    'cancel_url': cancelUrl,
    'payment_method_types[0]': 'card',
    'metadata[program]': program,
    'metadata[name]': p.name,
    'metadata[page_url]': pageUrl
  };
  // 明細1: コース × 人数
  params['line_items[0][quantity]'] = guests;
  params['line_items[0][price_data][currency]'] = 'jpy';
  params['line_items[0][price_data][unit_amount]'] = price;
  params['line_items[0][price_data][product_data][name]'] =
    (PROGRAM_LABEL[program] || '') + ' ' + course + ' コース';
  // 明細2: オプション（あれば）
  if (optionsTot > 0) {
    params['line_items[1][quantity]'] = 1;
    params['line_items[1][price_data][currency]'] = 'jpy';
    params['line_items[1][price_data][unit_amount]'] = optionsTot;
    params['line_items[1][price_data][product_data][name]'] = 'オプション: ' + (optionsText || '各種');
  }

  var resp = UrlFetchApp.fetch(STRIPE_API + '/checkout/sessions', {
    method: 'post',
    payload: params,
    headers: { Authorization: 'Bearer ' + secret },
    muteHttpExceptions: true
  });
  var session = JSON.parse(resp.getContentText());
  if (!session || !session.id || !session.url) {
    Logger.log('Stripe error: ' + resp.getContentText());
    var msg = (session && session.error && session.error.message) || '決済セッションの作成に失敗しました。';
    return htmlPage('決済エラー', '<p>' + esc(msg) + '</p>');
  }

  // 予約を「決済待ち」で先行記録（session.id を保存）
  appendPendingBooking({
    program: program, course: course, guests: guests, date: p.date,
    options: optionsText, total: total, name: p.name, email: p.email,
    phone: p.phone, health: p.health || '', note: p.note || ''
  }, session.id);

  // Stripe Checkout へリダイレクト（トップレベル遷移）
  return redirectPage(session.url);
}

function appendPendingBooking(d, sessionId) {
  var sheetName = PROGRAM_SHEET[d.program] || 'その他予約';
  var sheet = getOrCreateSheet(sheetName, SHEET_HEADERS);
  sheet.appendRow([
    formatJst(new Date()),
    PROGRAM_LABEL[d.program] || d.program,
    d.course, d.guests, d.date, d.options, Number(d.total) || 0,
    d.name, d.email, d.phone, d.health, d.note,
    STATUS_PENDING, sessionId
  ]);
}

// 決済を検証して確定（記録更新・カレンダー・メール）。冪等。
function finalizePayment(sessionId) {
  var secret = stripeSecret();
  if (!secret) return { ok: false, message: 'STRIPE_SECRET_KEY 未設定' };

  var resp = UrlFetchApp.fetch(STRIPE_API + '/checkout/sessions/' + encodeURIComponent(sessionId), {
    method: 'get',
    headers: { Authorization: 'Bearer ' + secret },
    muteHttpExceptions: true
  });
  var session = JSON.parse(resp.getContentText());
  if (!session || session.error) {
    return { ok: false, message: 'セッション取得失敗' };
  }
  var paid = (session.payment_status === 'paid');

  var hit = findRowBySession(sessionId);
  if (!hit) {
    return { ok: paid, pending: !paid, notfound: true,
             data: dataFromSession(session) };
  }

  var data = dataFromRow(hit.row, hit.program);
  if (session.metadata && session.metadata.page_url) data.page_url = session.metadata.page_url;

  if (hit.row[COL.status] === STATUS_PAID) {
    return { ok: true, already: true, data: data }; // 二重処理防止
  }
  if (!paid) {
    return { ok: false, pending: true, data: data };
  }

  // 確定処理
  hit.sheet.getRange(hit.rowIndex, COL.status + 1).setValue(STATUS_PAID);
  try { createBookingEvent(data, hit.program); } catch (calErr) { Logger.log('Calendar: ' + calErr.message); }
  try {
    MailApp.sendEmail({ to: data.email, subject: '【んだばい】ご予約・お支払いを承りました',
      htmlBody: createConfirmationEmail(data, hit.program) });
  } catch (mErr) { Logger.log('Mail(customer): ' + mErr.message); }
  try {
    MailApp.sendEmail({ to: ADMIN_EMAIL, subject: '【決済完了・新規予約】' + (data.name || '') + ' / ' + (data.course || ''),
      htmlBody: createAdminNotification(data, hit.program) });
  } catch (mErr) { Logger.log('Mail(admin): ' + mErr.message); }

  return { ok: true, data: data };
}

function findRowBySession(sessionId) {
  for (var key in PROGRAM_SHEET) {
    var sheet = getSpreadsheet().getSheetByName(PROGRAM_SHEET[key]);
    if (!sheet) continue;
    var values = sheet.getDataRange().getValues();
    for (var i = 1; i < values.length; i++) {
      if (String(values[i][COL.session]) === String(sessionId)) {
        return { sheet: sheet, row: values[i], rowIndex: i + 1, program: key };
      }
    }
  }
  return null;
}

function dataFromRow(row, programKey) {
  return {
    program: programKey,
    course: row[COL.course], guests: row[COL.guests], date: row[COL.date],
    options: row[COL.options], total: row[COL.total],
    name: row[COL.name], email: row[COL.email], phone: row[COL.phone],
    health: row[COL.health], note: row[COL.note]
  };
}

function dataFromSession(session) {
  var m = session.metadata || {};
  return { name: m.name || '', program: m.program || '', email: session.customer_email || '',
           total: (session.amount_total || 0), page_url: m.page_url || '', course: '', date: '', options: '' };
}

// 取りこぼし救済: 「決済待ち」行を Stripe で再確認して確定（任意でトリガー実行）
function reconcilePendingPayments() {
  for (var key in PROGRAM_SHEET) {
    var sheet = getSpreadsheet().getSheetByName(PROGRAM_SHEET[key]);
    if (!sheet) continue;
    var values = sheet.getDataRange().getValues();
    for (var i = 1; i < values.length; i++) {
      if (values[i][COL.status] === STATUS_PENDING && values[i][COL.session]) {
        try { finalizePayment(String(values[i][COL.session])); } catch (e) { Logger.log('reconcile: ' + e.message); }
      }
    }
  }
}

function stripeSecret() {
  return PropertiesService.getScriptProperties().getProperty('STRIPE_SECRET_KEY');
}

function toInt(v) { var n = parseInt(String(v == null ? '' : v).replace(/[^\d-]/g, ''), 10); return isNaN(n) ? 0 : n; }

// ---- 旧クライアント互換（決済なしの直接記録） -----------------------

function legacyRecord(data) {
  var required = { name: 'お名前', email: 'メール', phone: '電話', course: 'コース', date: '希望日' };
  for (var k in required) {
    if (!data[k] || String(data[k]).trim() === '') {
      return jsonOutput({ status: 'error', message: required[k] + ' は必須です。' });
    }
  }
  var program = data.program || 'unknown';
  var optionsText = Array.isArray(data.options) ? data.options.join('、') : (data.options || '');
  var sheet = getOrCreateSheet(PROGRAM_SHEET[program] || 'その他予約', SHEET_HEADERS);
  sheet.appendRow([
    formatJst(new Date()), PROGRAM_LABEL[program] || program, data.course || '', data.guests || '',
    data.date || '', optionsText, Number(data.total) || 0, data.name || '', data.email || '',
    data.phone || '', data.health || '', data.note || '', '新規', ''
  ]);
  try { createBookingEvent(data, program); } catch (e) { Logger.log('Calendar: ' + e.message); }
  try { MailApp.sendEmail({ to: data.email, subject: '【んだばい】ご予約リクエストを受け付けました',
      htmlBody: createConfirmationEmail(data, program) }); } catch (e) {}
  try { MailApp.sendEmail({ to: ADMIN_EMAIL, subject: '【新規予約】' + (data.name || '') + ' / ' + (data.course || ''),
      htmlBody: createAdminNotification(data, program) }); } catch (e) {}
  return jsonOutput({ status: 'success', message: '予約を受け付けました' });
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

function formatJst(d) { return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm'); }

function getCalendar() {
  if (CALENDAR_ID) { var c = CalendarApp.getCalendarById(CALENDAR_ID); if (c) return c; }
  return CalendarApp.getDefaultCalendar();
}

function createBookingEvent(data, program) {
  if (!data.date) return;
  var start = new Date(data.date + 'T12:00:00+09:00');
  if (isNaN(start.getTime())) return;
  var end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  var title = '【予約・決済済】' + (data.name || '') + ' / ' + (PROGRAM_LABEL[program] || program) + ' ' + (data.course || '');
  getCalendar().createEvent(title, start, end, { description: JSON.stringify(data, null, 2) });
}

function jsonOutput(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---- 画面（HtmlService） -------------------------------------------

function htmlPage(title, bodyHtml) {
  var html = '<!doctype html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + esc(title) + '</title>' +
    '<style>body{font-family:sans-serif;background:#f7f1e6;color:#3a2e1f;line-height:1.8;' +
    'display:flex;min-height:90vh;align-items:center;justify-content:center;padding:24px}' +
    '.card{background:#fff;max-width:520px;width:100%;border-radius:16px;padding:32px;' +
    'box-shadow:0 8px 30px rgba(0,0,0,.08)}h1{font-size:20px;margin:0 0 12px}' +
    'a.btn{display:inline-block;margin-top:18px;background:#c0894b;color:#fff;text-decoration:none;' +
    'padding:12px 22px;border-radius:999px}table{border-collapse:collapse;margin:12px 0;font-size:14px}' +
    'th{text-align:left;padding:6px 12px;background:#f3ebe0;border:1px solid #e6ddcd;white-space:nowrap}' +
    'td{padding:6px 12px;border:1px solid #e6ddcd}</style></head><body><div class="card">' +
    '<h1>' + esc(title) + '</h1>' + bodyHtml + '</div></body></html>';
  return HtmlService.createHtmlOutput(html)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function redirectPage(url) {
  // GAS はサンドボックスiframe内で実行されるため、トップ遷移が自動で効かない場合に備え、
  // ユーザー操作で確実に遷移する target="_top" のボタンを必ず併設する。
  // （meta refresh は iframe を遷移させ Stripe の frame 制限に阻まれるため使用しない）
  var html = '<!doctype html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>お支払いへ</title>' +
    '<style>body{font-family:sans-serif;background:#f7f1e6;color:#3a2e1f;text-align:center;padding:48px 24px;line-height:1.8}' +
    '.btn{display:inline-block;margin-top:16px;background:#c0894b;color:#fff;text-decoration:none;' +
    'padding:14px 28px;border-radius:999px;font-size:16px}</style></head><body>' +
    '<p>決済ページ（Stripe）へ移動します…</p>' +
    '<p><a class="btn" href="' + esc(url) + '" target="_top" rel="noopener">お支払いに進む ▶</a></p>' +
    '<script>try{window.top.location.href=' + JSON.stringify(url) + ';}catch(e){}' +
    'setTimeout(function(){try{window.top.location.href=' + JSON.stringify(url) + ';}catch(e){}},300);</script>' +
    '</body></html>';
  return HtmlService.createHtmlOutput(html).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function renderResultPage(res) {
  if (res && res.ok && res.data) {
    var d = res.data;
    var back = (res.data.page_url) ? res.data.page_url : '';
    var body =
      '<p>✅ お支払いと予約を承りました。<br>確認メールをお送りしましたのでご確認ください。</p>' +
      '<table>' +
      trow('コース', d.course) +
      trow('希望日', d.date) +
      trow('人数', (d.guests || '') + '名') +
      trow('オプション', d.options || 'なし') +
      trow('お支払い合計', yen(d.total)) +
      '</table>' +
      '<p style="font-size:13px;color:#8a7a63">【キャンセルポリシー】7日前まで無料／3〜6日前 50%／前日 80%／当日・無断 100%</p>' +
      (back ? '<a class="btn" href="' + esc(back) + '" target="_top" rel="noopener">サイトに戻る</a>' : '');
    return htmlPage('ご予約ありがとうございます', body);
  }
  if (res && res.pending) {
    return htmlPage('お支払い確認中',
      '<p>お支払いの確認が取れ次第、確認メールをお送りします。しばらくお待ちください。</p>');
  }
  return htmlPage('確認できませんでした',
    '<p>決済状況を確認できませんでした。お手数ですが ' + esc(ADMIN_EMAIL) + ' までお問い合わせください。</p>');
}

function trow(label, value) {
  return '<tr><th>' + esc(label) + '</th><td>' + esc(value) + '</td></tr>';
}

// ---- メールテンプレート --------------------------------------------

function createConfirmationEmail(data, program) {
  var label = PROGRAM_LABEL[program] || program;
  var opts = Array.isArray(data.options) ? (data.options.join('、') || 'なし') : (data.options || 'なし');
  return [
    '<div style="font-family:sans-serif;color:#3a2e1f;line-height:1.8">',
    '<p>' + esc(data.name) + ' 様</p>',
    '<p>この度は「んだばい 滞在型ファスティング・ウェルネス」にお申し込みいただき、誠にありがとうございます。<br>ご予約とお支払いを承りました。</p>',
    '<table style="border-collapse:collapse;margin:16px 0;font-size:14px">',
    row('プログラム', label),
    row('コース', data.course),
    row('希望日', data.date),
    row('人数', (data.guests || '') + '名'),
    row('オプション', opts),
    row('お支払い合計', yen(data.total)),
    '</table>',
    '<p>当日の流れや持ち物については、別途スタッフよりご案内いたします。</p>',
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
    '<p><strong>決済完了の新規予約が届きました。</strong></p>',
    '<table style="border-collapse:collapse;margin:12px 0;font-size:14px">',
    row('受付日時', formatJst(new Date())),
    row('プログラム', label),
    row('コース', data.course),
    row('希望日', data.date),
    row('人数', (data.guests || '') + '名'),
    row('オプション', opts),
    row('お支払い合計', yen(data.total)),
    row('お名前', data.name),
    row('メール', data.email),
    row('電話', data.phone),
    row('健康状態', data.health || '—'),
    row('備考', data.note || '—'),
    '</table>',
    ssUrl ? '<p><a href="' + ssUrl + '">▶ スプレッドシートで確認する</a></p>' : '',
    '</div>'
  ].join('');
}

function row(label, value) {
  return '<tr><th style="text-align:left;padding:6px 14px;background:#f3ebe0;border:1px solid #e6ddcd;white-space:nowrap">' +
    esc(label) + '</th><td style="padding:6px 14px;border:1px solid #e6ddcd">' + esc(value) + '</td></tr>';
}

function esc(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function yen(n) { var num = Number(n) || 0; return '¥' + num.toLocaleString('ja-JP'); }

// ---- 月次売上集計（時間主導トリガーで実行） ------------------------

function updateMonthlySales() {
  var ss = getSpreadsheet();
  var now = new Date();
  var monthKey = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM');
  var total = 0;
  var seen = {};
  for (var key in PROGRAM_SHEET) {
    var name = PROGRAM_SHEET[key];
    if (seen[name]) continue; // 同名シートの二重集計を防止
    seen[name] = true;
    total += sumMonthlySales(ss.getSheetByName(name), monthKey);
  }
  total += sumMonthlySales(ss.getSheetByName('その他予約'), monthKey);
  var commission = Math.round(total * 0.1);
  var salesSheet = getOrCreateSheet('売上集計', SALES_HEADERS);
  upsertSalesRow(salesSheet, monthKey, [monthKey, total, commission]);
}

// 売上は「決済済み」のみ集計
function sumMonthlySales(sheet, monthKey) {
  if (!sheet) return 0;
  var values = sheet.getDataRange().getValues();
  var sum = 0;
  for (var i = 1; i < values.length; i++) {
    if (values[i][COL.status] !== STATUS_PAID) continue;
    var ts = values[i][COL.ts];
    var amount = Number(values[i][COL.total]) || 0;
    var key = '';
    if (ts instanceof Date) key = Utilities.formatDate(ts, 'Asia/Tokyo', 'yyyy-MM');
    else if (ts) key = String(ts).slice(0, 7).replace('/', '-');
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

function setupMonthlyTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'updateMonthlySales') ScriptApp.deleteTrigger(triggers[i]);
  }
  ScriptApp.newTrigger('updateMonthlySales').timeBased().onMonthDay(1).atHour(2).create();
}
