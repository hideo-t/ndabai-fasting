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

  // ---- 月〜木・コース長による日程ルール ----
  const WD = ['日', '月', '火', '水', '木', '金', '土'];
  function courseNights(courseName) {
    const m = /(\d+)\s*泊/.exec(courseName || '');
    return m ? parseInt(m[1], 10) : 0;
  }
  // チェックイン可能曜日（1=月 … 4=木）。滞在が月〜木に収まる範囲。
  function allowedCheckinDays(nights) {
    const out = [];
    for (let d = 1; d <= 4 - nights; d++) out.push(d);
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
    const optionsPerPerson = opts.reduce((s, o) => s + o.price, 0); // オプションは1名あたり
    const optionsTotal = optionsPerPerson * guests; // 人数分を加算
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
    updateDateHint();
  }

  // 日程ヒント（コースに応じて選べる開始曜日を表示）
  function updateDateHint() {
    const hint = $('dateHint');
    if (!hint) return;
    const nights = courseNights(calc().courseName);
    if (!nights) {
      hint.innerHTML = '※ 施設稼働は毎週<strong>月〜木</strong>。コースを選ぶと開始曜日が決まります。';
      return;
    }
    const days = allowedCheckinDays(nights).map((d) => WD[d] + '曜').join('・');
    hint.innerHTML = '※ ' + nights + '泊コースのチェックインは <strong>' + days + '</strong> のみ（月〜木の稼働内で完結）。';
  }
  // 他ファイルから呼べるよう公開（インラインonchange互換）
  window.updateSummary = updateSummary;

  // バリデーション（必須項目）
  function validate(data) {
    if (!data.course) return 'コースを選択してください。';
    if (!data.date) return '希望日程を選択してください。';
    // 月〜木・コース長チェック（滞在が月〜木に収まること）
    const nights = courseNights(data.course);
    if (nights > 0) {
      const dow = new Date(data.date + 'T00:00:00').getDay();
      const allowed = allowedCheckinDays(nights);
      if (allowed.indexOf(dow) === -1) {
        return 'このコース（' + nights + '泊）のチェックインは ' +
          allowed.map((d) => WD[d] + '曜').join('・') + ' のみです（施設稼働：月〜木）。';
      }
    }
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
  const origBtnText = submitBtn ? submitBtn.textContent : '予約して決済へ進む';

  function showMessage(type, html) {
    if (!messageEl) return;
    messageEl.className = 'form-message ' + type;
    messageEl.innerHTML = html;
    messageEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // Stripe Checkout へ遷移するための隠しフォームPOST（CORS回避のためトップレベル遷移）
  function redirectToCheckout(payload) {
    const fields = {
      action: 'checkout',
      program: payload.program,
      course: payload.course,
      price: payload.price,
      guests: payload.guests,
      date: payload.date,
      options: (payload.options || []).join('、'),
      optionsTotal: payload.optionsTotal,
      total: payload.total,
      name: payload.name,
      email: payload.email,
      phone: payload.phone,
      health: payload.health,
      note: payload.note,
      page_url: location.origin + location.pathname,
    };
    const f = document.createElement('form');
    f.method = 'POST';
    f.action = GAS_ENDPOINT;
    f.style.display = 'none';
    Object.keys(fields).forEach((k) => {
      const i = document.createElement('input');
      i.type = 'hidden';
      i.name = k;
      i.value = fields[k] == null ? '' : String(fields[k]);
      f.appendChild(i);
    });
    document.body.appendChild(f);
    f.submit();
  }

  async function submit() {
    const payload = buildPayload();

    const err = validate(payload);
    if (err) { showMessage('error', err); return; }

    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '決済ページへ移動中...'; }
    if (retryBtn) retryBtn.classList.remove('show');

    if (GAS_ENDPOINT) {
      // GAS が Stripe Checkout セッションを作成 → 決済ページへリダイレクト。ここでページ遷移する。
      showMessage('success', '決済ページ（Stripe）へ移動します…そのままお待ちください。');
      redirectToCheckout(payload);
      return;
    }

    // GAS_ENDPOINT 未設定 = デモモード（決済・送信なし）
    try {
      await new Promise((r) => setTimeout(r, 1000));
      console.warn('GAS_ENDPOINT 未設定のためデモモードで動作しています（決済・送信は行われません）。');
      showMessage('success', '✅【デモ】ご予約内容を確認しました。<br>本番環境では決済ページへ進みます。');
      form.reset();
      updateSummary();
    } catch (e) {
      showMessage('error', '⚠️ エラーが発生しました。再度お試しください。');
      if (retryBtn) retryBtn.classList.add('show');
    } finally {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = origBtnText; }
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

  // 決済をキャンセルして戻ってきた場合
  try {
    if (/[?&]canceled=1/.test(location.search)) {
      showMessage('error', '決済をキャンセルしました。内容をご確認のうえ、もう一度お試しください。');
    }
  } catch (e) {}
})();
