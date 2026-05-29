/* =============================================================
   んだばい 予約フォーム共通スクリプト
   料金計算 / バリデーション / GAS送信
   ============================================================= */

// ⬇⬇⬇ デプロイした Google Apps Script のウェブアプリURLをここに貼り付けてください（gas/README.md 参照）
//      空のままだと「デモモード」で動作し、送信内容は記録されません。
const GAS_ENDPOINT = 'https://script.google.com/macros/s/AKfycbxtjuYfInAbZt__Fq1X3RSccwx8KSrTd1OtZ9ppkb--htyN3W8Z1l4Xgu2JTBI68aJ3/exec';

(function () {
  'use strict';

  const form = document.getElementById('bookingForm');
  if (!form) return; // 予約フォームの無いページ（トップ等）では何もしない

  const $ = (id) => document.getElementById(id);

  // 希望日の最小値を「明日」に
  const dateEl = $('date');
  if (dateEl) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    dateEl.min = tomorrow.toISOString().split('T')[0];
  }

  // 選択中オプションを取得 [{name, price}]
  function getSelectedOptions() {
    const out = [];
    form.querySelectorAll('.booking-opt input:checked').forEach((input) => {
      const parts = String(input.value).split('|');
      out.push({ name: parts[0], price: parseInt(parts[1], 10) || 0 });
    });
    return out;
  }

  // 現在の選択から金額を算出
  function calc() {
    const courseEl = $('course');
    const guests = parseInt($('guests') ? $('guests').value : '1', 10) || 1;

    let courseName = '';
    let price = 0;
    if (courseEl && courseEl.value) {
      const parts = courseEl.value.split('|');
      courseName = parts[0];
      price = parseInt(parts[1], 10) || 0;
    }

    const opts = getSelectedOptions();
    const optionsTotal = opts.reduce((s, o) => s + o.price, 0); // オプションは1予約あたり
    const total = price * guests + optionsTotal;

    return {
      courseName, price, guests,
      options: opts.map((o) => o.name),
      optionsTotal, total,
    };
  }

  const yen = (n) => '¥' + Number(n).toLocaleString();

  // サマリー表示の更新
  function updateSummary() {
    const c = calc();
    if ($('sumCourse')) $('sumCourse').textContent = c.courseName || '未選択';
    if ($('sumGuests')) $('sumGuests').textContent = c.guests + '名';
    if ($('sumOptions')) $('sumOptions').textContent = c.options.length ? c.options.join('、') : 'なし';
    if ($('sumTotal')) $('sumTotal').textContent = yen(c.total);
  }
  // 他ファイルから呼べるよう公開（インラインonchange互換）
  window.updateSummary = updateSummary;

  // バリデーション（必須項目）
  function validate(data) {
    if (!data.course) return 'コースを選択してください。';
    if (!data.date) return '希望日程を選択してください。';
    if (!data.name) return 'お名前を入力してください。';
    if (!data.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data.email)) return '正しいメールアドレスを入力してください。';
    if (!data.phone) return '電話番号を入力してください。';
    return null;
  }

  // 送信ペイロード組み立て（GAS契約に整合）
  function buildPayload() {
    const c = calc();
    return {
      program: (form.querySelector('input[name="program"]') || {}).value || 'unknown',
      course: c.courseName,
      price: c.price,
      guests: c.guests,
      date: $('date') ? $('date').value : '',
      options: c.options,
      optionsTotal: c.optionsTotal,
      total: c.total,
      name: $('name') ? $('name').value.trim() : '',
      email: $('email') ? $('email').value.trim() : '',
      phone: $('phone') ? $('phone').value.trim() : '',
      health: $('health') ? $('health').value.trim() : '',
      note: $('message') ? $('message').value.trim() : '',
      timestamp: new Date().toISOString(),
    };
  }

  const messageEl = $('formMessage');
  const submitBtn = $('submitBtn');
  const retryBtn = $('retryBtn');

  function showMessage(type, html) {
    if (!messageEl) return;
    messageEl.className = 'form-message ' + type;
    messageEl.innerHTML = html;
    messageEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function submit() {
    const payload = buildPayload();

    const err = validate(payload);
    if (err) { showMessage('error', err); return; }

    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '送信中...'; }
    if (retryBtn) retryBtn.classList.remove('show');

    try {
      if (GAS_ENDPOINT) {
        // CORSプリフライトを避けるためContent-Type未指定の単純POST
        await fetch(GAS_ENDPOINT, { method: 'POST', body: JSON.stringify(payload) });
      } else {
        await new Promise((r) => setTimeout(r, 1200));
        console.warn('GAS_ENDPOINT 未設定のためデモモードで動作しています（送信は記録されません）。');
      }

      showMessage('success', '✅ 予約リクエストを受け付けました！<br>24時間以内に確認メールをお送りします。');
      form.reset();
      updateSummary();
    } catch (e) {
      showMessage('error', '⚠️ 送信に失敗しました。通信環境をご確認のうえ、再度お試しください。');
      if (retryBtn) retryBtn.classList.add('show');
    } finally {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '予約リクエストを送信'; }
    }
  }

  // イベント配線
  form.addEventListener('submit', function (e) { e.preventDefault(); submit(); });
  if (retryBtn) retryBtn.addEventListener('click', submit);

  ['course', 'guests'].forEach((id) => { if ($(id)) $(id).addEventListener('change', updateSummary); });
  if (dateEl) dateEl.addEventListener('change', updateSummary);
  form.querySelectorAll('.booking-opt input').forEach((input) => input.addEventListener('change', updateSummary));

  // 初期表示
  updateSummary();
})();
