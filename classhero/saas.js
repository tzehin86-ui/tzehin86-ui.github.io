/* 班級英雄 SaaS 外殼：插畫載入 → 登入 → 讀存檔 → 起 app → 權限（唯讀）→ 帳戶／學校頁
   app 本體（APPMAIN）一行都唔改；靠 build.py 喺 boot() 前後掛 CH_PRE／CH_POST。 */
(function () {
  'use strict';
  const CFG = window.CH_CONFIG || {};
  const CLOUD = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);
  // ?dev=1 只喺未接 Supabase 時有效（上線後唔會俾人用假帳戶）
  const DEV = !CLOUD && (CFG.DEV_FAKE_AUTH || /[?&]dev=1/.test(location.search));
  const PURE_LOCAL = !CLOUD && !DEV;              // 同而家單檔版一樣：冇登入、冇限制
  const TRIAL_DAYS = CFG.TRIAL_DAYS || 14;
  const DAY = 864e5;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $id = id => document.getElementById(id);
  const LSget = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
  const LSset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const loadMsg = t => { const m = $id('chLoadMsg'); if (m) m.textContent = t; };

  let api = null, user = null, profile = null, booted = false, lastGood = null;

  /* ================= 權限 ================= */
  function entitlement(p) {
    if (PURE_LOCAL || !p) return { write: true, kind: 'local', daysLeft: Infinity };
    if (p.plan === 'teacher_active') return { write: true, kind: 'teacher', daysLeft: Infinity };
    if (p.plan === 'school_seat' && (!p.school || ['active', 'trialing'].includes(p.school.status)))
      return { write: true, kind: 'school', daysLeft: Infinity };
    const left = Math.ceil((new Date(p.trial_ends_at).getTime() - Date.now()) / DAY);
    return left > 0 ? { write: true, kind: 'trial', daysLeft: left } : { write: false, kind: 'expired', daysLeft: 0 };
  }
  const canWrite = () => entitlement(profile).write;

  /* ================= 後端：假帳戶（DEV）同 Supabase 同一個介面 ================= */
  function fakeApi() {
    const SK = 'ch_dev_session', PK = 'ch_dev_profiles', IK = 'ch_dev_invites';
    const profs = () => LSget(PK) || {};
    const me = () => { const s = LSget(SK); return s && profs()[s.uid]; };
    const put = p => { const all = profs(); all[p.user_id] = p; LSset(PK, all); };
    return {
      name: 'dev',
      async session() { const s = LSget(SK); return s ? { id: s.uid, email: s.email } : null; },
      async signIn(email) {
        const uid = 'dev-' + email.toLowerCase().replace(/[^a-z0-9]/g, '');
        LSset(SK, { uid, email });
        if (!profs()[uid]) {
          // 模擬 DB trigger：建 profile＋14 日試用；有學校邀請就自動入學校
          const inv = (LSget(IK) || []).find(i => i.email === email.toLowerCase());
          if (inv) inv.accepted = true, LSset(IK, (LSget(IK) || []).map(i => i.email === inv.email ? inv : i));
          put({ user_id: uid, email, plan: inv ? 'school_seat' : 'trial', role: 'teacher',
            trial_ends_at: new Date(Date.now() + TRIAL_DAYS * DAY).toISOString(), school_id: inv ? inv.school_id : null });
        }
        return { direct: true };
      },
      async signOut() { localStorage.removeItem(SK); },
      async profile() {
        const p = me(); if (!p) return null;
        const sch = LSget('ch_dev_school');
        return Object.assign({}, p, { school: p.school_id && sch && sch.id === p.school_id ? sch : null });
      },
      async invites() { const p = me(); return (LSget(IK) || []).filter(i => i.school_id === p.school_id); },
      async invite(email) { const p = me(); const l = LSget(IK) || []; if (!l.some(i => i.email === email)) l.push({ school_id: p.school_id, email, accepted: false }); LSset(IK, l); },
      async uninvite(email) { const p = me(); LSset(IK, (LSget(IK) || []).filter(i => !(i.school_id === p.school_id && i.email === email))); },
      async checkout(kind, opt) {
        const p = me();
        if (kind === 'school') {
          const sch = { id: 'dev-school', name: opt.schoolName || '測試學校', seats: opt.seats, status: 'active' };
          LSset('ch_dev_school', sch); p.school_id = sch.id; p.role = 'school_admin'; p.plan = 'school_seat';
        } else p.plan = 'teacher_active';
        put(p);
        return { dev: true, msg: 'DEV：真環境會跳去 Stripe Checkout（' + (kind === 'school' ? opt.seats + ' 個席位' : '個人月費') + '）；而家直接當付款成功。' };
      },
      async portal() { return { dev: true, msg: 'DEV：真環境會跳去 Stripe Customer Portal。' }; },
      // 開發用：改試用日數／角色
      dev: {
        trial(days) { const p = me(); p.plan = 'trial'; p.trial_ends_at = new Date(Date.now() + days * DAY).toISOString(); put(p); },
        role(r) { const p = me(); p.role = r; if (r === 'school_admin' && !p.school_id) { LSset('ch_dev_school', { id: 'dev-school', name: '測試學校', seats: 5, status: 'active' }); p.school_id = 'dev-school'; } put(p); }
      }
    };
  }

  function supabaseApi(sb) {
    const fn = async (name, body) => {
      const { data, error } = await sb.functions.invoke(name, { body });
      if (error) throw error; return data;
    };
    return {
      name: 'supabase', sb,
      async session() { const { data } = await sb.auth.getSession(); return data.session ? data.session.user : null; },
      async signIn(email) {
        const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
        if (error) throw error; return { direct: false };
      },
      async signOut() { await sb.auth.signOut(); },
      async profile() {
        const { data, error } = await sb.from('profiles').select('*, school:schools(id,name,seats,status,current_period_end)').eq('user_id', user.id).single();
        if (error) throw error; return data;
      },
      async invites() {
        const { data, error } = await sb.from('school_invites').select('email,accepted,created_at').eq('school_id', profile.school_id).order('created_at');
        if (error) throw error; return data;
      },
      async invite(email) { const { error } = await sb.from('school_invites').insert({ school_id: profile.school_id, email }); if (error) throw error; },
      async uninvite(email) { const { error } = await sb.from('school_invites').delete().eq('school_id', profile.school_id).eq('email', email); if (error) throw error; },
      async checkout(kind, opt) { return fn('create-checkout', Object.assign({ kind, return_url: location.origin + location.pathname }, opt)); },
      async portal() { return fn('customer-portal', { return_url: location.origin + location.pathname }); }
    };
  }

  function loadScript(src) {
    return new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = no; document.head.appendChild(s); });
  }

  /* ================= 遮罩頁（登入／匯入／帳戶／學校／升級／衝突） ================= */
  function ov(html, opt) {
    opt = opt || {};
    let o = $id('chOv');
    if (!o) { o = document.createElement('div'); o.id = 'chOv'; document.body.appendChild(o); }
    o.className = opt.full ? 'full' : '';
    o.innerHTML = '<div class="chCard chPanel">' + (opt.close === false ? '' : '<button class="chX" id="chX" aria-label="關閉">✕</button>') + html + '</div>';
    o.hidden = false;
    const x = $id('chX'); if (x) x.onclick = closeOv;
    return o;
  }
  function closeOv() { const o = $id('chOv'); if (o) { o.hidden = true; o.innerHTML = ''; } }
  function note(t, bad) { const n = $id('chNote'); if (n) { n.textContent = t; n.className = 'chNote' + (bad ? ' bad' : ''); } }

  function loginPage() {
    return new Promise(done => {
      ov(`<div class="chLogo">🏰</div><h2>班級英雄</h2>
        <p class="chDim">用學校或者個人 email 登入，班級資料會跟住你個帳戶走，換電腦都唔怕。</p>
        <label class="chLbl">Email</label>
        <input id="chEmail" type="email" autocomplete="email" placeholder="teacher@school.edu.hk">
        <button class="chBtn main" id="chSend">✉️ 寄登入連結</button>
        <div id="chNote" class="chNote"></div>
        <p class="chDim small">新帳戶免費試用 ${TRIAL_DAYS} 日，唔使信用卡。${DEV ? '<br><b>DEV 模式：假帳戶，唔會寄 email。</b>' : ''}</p>`, { full: true, close: false });
      const go = async () => {
        const email = $id('chEmail').value.trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { note('請輸入正確 email', 1); return; }
        $id('chSend').disabled = true; note('寄緊…');
        try {
          const r = await api.signIn(email);
          if (r.direct) { done(); return; }
          note('✅ 已寄出登入連結去 ' + email + '，請去郵箱撳連結（可以關咗呢頁）。');
        } catch (e) { note('❌ ' + (e.message || e), 1); $id('chSend').disabled = false; }
      };
      $id('chSend').onclick = go;
      $id('chEmail').onkeydown = e => { if (e.key === 'Enter') go(); };
    });
  }

  /* 首次登入：揀匯入舊資料 */
  function importPage() {
    return new Promise(done => {
      let local = null;
      for (const k of ['classrpg_v3', 'classrpg_v2']) { const d = LSget(k); if (d && d.rooms) { local = d; break; } }
      const nStu = d => (d.rooms || []).reduce((n, r) => n + ((r.students || []).length), 0);
      ov(`<div class="chLogo">📦</div><h2>歡迎！要唔要搬舊資料過嚟？</h2>
        <p class="chDim">之前用單檔版（index.html）嘅老師，可以將班級一次過搬入帳戶。</p>
        ${local ? `<button class="chBtn main" id="chImpLocal">💻 用呢部電腦嘅資料（${(local.rooms || []).length} 個班、${nStu(local)} 位學生）</button>` : '<p class="chDim small">呢部電腦冇搵到舊資料。</p>'}
        <button class="chBtn" id="chImpFile">📂 上載備份檔（class-rpg-backup.json）</button>
        <button class="chBtn ghost" id="chImpNone">✨ 由空白班級開始</button>
        <div id="chNote" class="chNote"></div>`, { full: true, close: false });
      if (local) $id('chImpLocal').onclick = () => done(local);
      $id('chImpNone').onclick = () => done(null);
      $id('chImpFile').onclick = () => {
        const f = document.createElement('input'); f.type = 'file'; f.accept = '.json,application/json';
        f.onchange = () => {
          const file = f.files && f.files[0]; if (!file) return;
          const rd = new FileReader();
          rd.onload = () => {
            let d = null; try { d = JSON.parse(String(rd.result).replace(/^﻿/, '')); } catch (e) {}
            if (!d || !Array.isArray(d.rooms)) { note('❌ 呢個唔係班級英雄備份檔', 1); return; }
            done(d);
          };
          rd.readAsText(file);
        };
        f.click();
      };
      window.CH._importFromText = txt => { const d = JSON.parse(txt); if (!d || !Array.isArray(d.rooms)) throw new Error('bad'); done(d); };
    });
  }

  function upgradeCard(reason) {
    const e = entitlement(profile);
    ov(`<div class="chLogo">🔒</div><h2>${e.kind === 'expired' ? '免費試用已經完咗' : '需要升級'}</h2>
      <p class="chDim">${esc(reason || '而家係唯讀模式：所有班級資料都睇得到、可以匯出，但唔可以加分或者修改。')}</p>
      <div class="chPlans">
        <div class="chPlan"><b>個人老師</b><div class="chPrice">HK$38<small>／月</small></div><button class="chBtn main" id="chBuyT">升級</button></div>
        <div class="chPlan"><b>學校</b><div class="chPrice">HK$300<small>／位／年</small></div><button class="chBtn" id="chBuyS">學校方案</button></div>
      </div><div id="chNote" class="chNote"></div>`);
    $id('chBuyT').onclick = () => buy('teacher');
    $id('chBuyS').onclick = schoolBuyPage;
  }
  async function buy(kind, opt) {
    note('準備付款頁…');
    try {
      const r = await api.checkout(kind, opt || {});
      if (r.url) { location.href = r.url; return; }
      if (r.dev) { await refreshProfile(); accountPage(); note(r.msg); }
    } catch (e) { note('❌ ' + (e.message || e), 1); }
  }
  function schoolBuyPage() {
    ov(`<h2>🏫 學校方案</h2><p class="chDim">每位老師 HK$300／年。付款後喺「學校管理」用 email 邀請老師。</p>
      <label class="chLbl">學校名稱</label><input id="chSName" placeholder="例：聖保羅小學">
      <label class="chLbl">席位（老師人數）</label><input id="chSSeats" type="number" min="1" max="500" value="5">
      <button class="chBtn main" id="chSGo">前往付款</button><div id="chNote" class="chNote"></div>`);
    $id('chSGo').onclick = () => {
      const seats = Math.max(1, Math.min(500, parseInt($id('chSSeats').value, 10) || 1));
      const schoolName = $id('chSName').value.trim();
      if (!schoolName) { note('請填學校名稱', 1); return; }
      buy('school', { seats, schoolName });
    };
  }

  async function refreshProfile() { profile = await api.profile(); syncBadge(); return profile; }

  function accountPage() {
    const e = entitlement(profile);
    const planTxt = { teacher: '個人老師（月費）', school: '學校方案' + (profile.school ? '：' + esc(profile.school.name) : ''), trial: '免費試用', expired: '試用已完（唯讀）' }[e.kind];
    const isAdmin = profile.role === 'school_admin';
    ov(`<h2>👤 我的帳戶</h2>
      <div class="chRow"><span class="chDim">Email</span><b>${esc(profile.email || user.email)}</b></div>
      <div class="chRow"><span class="chDim">方案</span><b>${planTxt}</b></div>
      ${e.kind === 'trial' ? `<div class="chRow"><span class="chDim">試用剩餘</span><b class="chTrial">${e.daysLeft} 日</b></div>` : ''}
      ${e.kind === 'expired' ? '<div class="chWarn">🔒 唯讀模式：資料保留，但唔可以加分／修改。</div>' : ''}
      <div class="chBtns">
        ${e.kind === 'trial' || e.kind === 'expired' ? '<button class="chBtn main" id="chUp">⭐ 升級（HK$38／月）</button><button class="chBtn" id="chUpS">🏫 學校方案</button>' : ''}
        ${e.kind === 'teacher' || isAdmin ? '<button class="chBtn" id="chPortal">💳 管理訂閱</button>' : ''}
        ${isAdmin ? '<button class="chBtn" id="chSchool">🏫 學校管理</button>' : ''}
        <button class="chBtn ghost" id="chOut">登出</button>
      </div>
      <div id="chNote" class="chNote"></div>
      ${DEV ? `<details class="chDev"><summary>🛠 DEV 工具</summary>
        <button class="chBtn ghost" data-t="14">試用 14 日</button><button class="chBtn ghost" data-t="1">剩 1 日</button>
        <button class="chBtn ghost" data-t="-1">試用已過期</button><button class="chBtn ghost" id="chDevAdmin">做學校管理員</button></details>` : ''}`);
    const b = (id, f) => { const x = $id(id); if (x) x.onclick = f; };
    b('chUp', () => buy('teacher')); b('chUpS', schoolBuyPage); b('chSchool', schoolPage);
    b('chPortal', async () => { note('開緊…'); try { const r = await api.portal(); if (r.url) location.href = r.url; else note(r.msg); } catch (er) { note('❌ ' + (er.message || er), 1); } });
    b('chOut', async () => { await api.signOut(); location.reload(); });
    if (DEV) {
      document.querySelectorAll('.chDev [data-t]').forEach(x => x.onclick = async () => { api.dev.trial(+x.dataset.t); await refreshProfile(); accountPage(); });
      b('chDevAdmin', async () => { api.dev.role('school_admin'); await refreshProfile(); accountPage(); });
    }
  }

  async function schoolPage() {
    const s = profile.school || {};
    ov(`<h2>🏫 學校管理</h2>
      <div class="chRow"><span class="chDim">學校</span><b>${esc(s.name || '—')}</b></div>
      <div class="chRow"><span class="chDim">席位</span><b id="chSeatUse">…</b></div>
      <div class="chRow"><span class="chDim">狀態</span><b>${esc({ active: '✅ 生效中', trialing: '試用中', past_due: '⚠️ 逾期未付', canceled: '已取消', pending: '等待付款' }[s.status] || s.status || '—')}</b></div>
      <label class="chLbl">邀請老師（email）</label>
      <div class="chInline"><input id="chInv" type="email" placeholder="teacher@school.edu.hk"><button class="chBtn main" id="chInvGo">邀請</button></div>
      <div id="chNote" class="chNote"></div>
      <ul class="chList" id="chInvList"><li class="chDim">載入中…</li></ul>
      <p class="chDim small">老師用被邀請嘅 email 登入就會自動加入學校。要加席位：撳「管理訂閱」改數量。</p>
      <button class="chBtn ghost" id="chBack">← 返帳戶</button>`);
    $id('chBack').onclick = accountPage;
    const draw = async () => {
      let list = [];
      try { list = await api.invites(); } catch (e) { note('❌ ' + (e.message || e), 1); }
      $id('chSeatUse').textContent = list.length + ' / ' + (s.seats || 0) + ' 已用';
      $id('chInvList').innerHTML = list.length ? list.map(i => `<li><span>${esc(i.email)} ${i.accepted ? '<em class="ok">已加入</em>' : '<em>未登入</em>'}</span><button class="chMini" data-e="${esc(i.email)}">移除</button></li>`).join('') : '<li class="chDim">未有邀請</li>';
      $id('chInvList').querySelectorAll('[data-e]').forEach(x => x.onclick = async () => {
        if (!confirm('移除 ' + x.dataset.e + '？佢會失去學校方案（資料保留）。')) return;
        try { await api.uninvite(x.dataset.e); draw(); } catch (e) { note('❌ ' + (e.message || e), 1); }
      });
      return list;
    };
    let cur = await draw();
    $id('chInvGo').onclick = async () => {
      const email = $id('chInv').value.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { note('請輸入正確 email', 1); return; }
      if (cur.length >= (s.seats || 0)) { note('席位已滿，請先喺「管理訂閱」加席位', 1); return; }
      try { await api.invite(email); $id('chInv').value = ''; note('✅ 已邀請 ' + email); cur = await draw(); } catch (e) { note('❌ ' + (e.message || e), 1); }
    };
  }

  function conflictPage(remote) {
    ov(`<div class="chLogo">🔄</div><h2>另一部機有新資料，載入？</h2>
      <p class="chDim">雲端版本更新於 ${esc(new Date(remote.updated_at).toLocaleString())}。<br>
      「載入」會用雲端嗰份；「保留呢部機」會用呢度嘅資料覆蓋雲端。</p>
      <button class="chBtn main" id="chCfLoad">⬇️ 載入雲端新資料</button>
      <button class="chBtn" id="chCfKeep">💻 保留呢部機嘅資料</button>`, { close: false });
    $id('chCfLoad').onclick = () => { store.dropPending(); location.reload(); };
    $id('chCfKeep').onclick = () => {
      closeOv();
      const mine = store.pendingData();      // 畫面可能顯示緊雲端版（重開頁時），換返呢部機嗰份
      if (mine) { try { DB = normalize(JSON.parse(JSON.stringify(mine))); S = DB.rooms[Math.min(DB.cur, DB.rooms.length - 1)]; lastGood = JSON.stringify(DB); applyUI(); render(); } catch (e) { console.warn(e); } }
      store.keepMine(remote);
    };
  }

  /* ================= 帳戶掣（header） ================= */
  function syncBadge() {
    const b = $id('chAcct'); if (!b || !profile) return;
    const e = entitlement(profile);
    b.textContent = e.kind === 'trial' ? '👤 試用 ' + e.daysLeft + ' 日' : e.kind === 'expired' ? '🔒 唯讀' : '👤';
    b.classList.toggle('ro', !e.write);
    document.body.classList.toggle('chRO', !e.write);
  }

  /* ================= 掛鈎：boot 前／後 ================= */
  window.CH_PRE = function () {
    if (PURE_LOCAL) return;
    // 雲端模式：唔讀亦唔寫舊 localStorage 存檔（公家電腦唔留學生資料；舊資料原封不動，可以之後匯入）
    window.fromLocal = () => null;
    const _set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) { if (this === localStorage && (k === 'classrpg_v3' || k === 'classrpg_prev')) return; return _set.call(this, k, v); };
    const _save = window.save;
    window.save = function () {
      if (!canWrite()) { revert(); upgradeCard(); return; }
      const r = _save.apply(this, arguments);
      try { dirty = false; fileDirty = false; } catch (e) {}   // 原 app 嘅 artifact／離線檔旗；SaaS 由 store 管，唔好觸發佢嘅離開警告
      store.save(DB); lastGood = JSON.stringify(DB); return r;
    };
    for (const f of ['award', 'awardMany']) {
      const o = window[f]; if (typeof o !== 'function') continue;
      window[f] = function () { if (!canWrite()) { upgradeCard(); return; } return o.apply(this, arguments); };
    }
  };
  function revert() {
    try { if (lastGood) { DB = normalize(JSON.parse(lastGood)); S = DB.rooms[Math.min(DB.cur, DB.rooms.length - 1)]; applyUI(); render(); } } catch (e) { console.warn('revert', e); }
  }
  window.CH_POST = function () {
    booted = true;
    try { lastGood = JSON.stringify(DB); } catch (e) {}
    if (PURE_LOCAL) return;
    store.onStatus = t => { try { setSync(t); } catch (e) {} };
    store.onConflict = conflictPage;
    store.onDenied = async () => { await refreshProfile().catch(() => {}); upgradeCard('雲端拒絕咗今次儲存（方案已到期或者已被移除）。'); };
    const h = document.querySelector('header');
    if (h) { const b = document.createElement('button'); b.id = 'chAcct'; b.className = 'nb chAcct'; b.onclick = accountPage; h.appendChild(b); }
    syncBadge();
    if (!canWrite()) setTimeout(() => upgradeCard(), 300);
  };

  /* ================= 起 app：執行 APPMAIN ================= */
  function runApp() {
    const code = $id('APPMAIN').textContent;
    // app 用 addEventListener('DOMContentLoaded') 量 header 高度；而家延遲執行，要即刻補 call
    const _ael = window.addEventListener;
    window.addEventListener = function (t, f, o) {
      if (t === 'DOMContentLoaded' || t === 'load') { setTimeout(f, 0); return; }
      return _ael.call(this, t, f, o);
    };
    const s = document.createElement('script'); s.textContent = code;
    try { document.body.appendChild(s); } finally { window.addEventListener = _ael; }
  }

  async function loadArt() {
    const man = await (await fetch('art/manifest.json', { cache: 'no-cache' })).json();
    const out = {}; let n = 0; const keys = Object.keys(man);
    await Promise.all(keys.map(async g => {
      const r = await fetch(man[g].file + '?v=' + man[g].v);
      if (!r.ok) throw new Error('插畫載入失敗：' + g);
      out[g] = await r.json(); loadMsg('載入插畫 ' + (++n) + '/' + keys.length);
    }));
    $id('ARTDATA').textContent = JSON.stringify(out);
  }

  async function start() {
    try {
      loadMsg('載入插畫…');
      const artP = loadArt();
      if (PURE_LOCAL) { await artP; done(); runApp(); return; }

      if (CLOUD) {
        loadMsg('連接雲端…');
        await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js');
        const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { auth: { persistSession: true, detectSessionInUrl: true } });
        api = supabaseApi(sb);
      } else api = fakeApi();
      window.CH.api = api;

      user = await api.session();
      if (!user) { done(); await loginPage(); user = await api.session(); }
      if (!user) return;
      loadMsg('讀取帳戶…');
      await refreshProfile();
      if (/[?&]paid=1/.test(location.search)) {
        // Stripe 跳返嚟：webhook 可能遲幾秒先寫 DB，輪詢 profile（每 2 秒，最多 20 秒）
        for (let i = 0; i < 10 && !['teacher', 'school'].includes(entitlement(profile).kind); i++) {
          loadMsg('付款處理中…（' + (i + 1) * 2 + '秒）');
          await new Promise(r => setTimeout(r, 2000));
          await refreshProfile().catch(() => {});
        }
        history.replaceState(null, '', location.pathname + location.hash);
      }
      store.init(CLOUD ? store.adapters.supabase(api.sb, user.id) : store.adapters.local(user.id), user.id);
      loadMsg('讀取班級資料…');
      let rec = await store.load();
      let data = rec && rec.data;
      if (!rec) {
        done();
        const imp = await importPage();
        closeOv();
        if (imp && canWrite()) { data = imp; store.save(imp); }
        else if (imp) data = imp;            // 唯讀都俾佢睇
      }
      $id('DBSTATE').textContent = data ? JSON.stringify(data) : 'null';
      await artP; done(); closeOv(); runApp();
    } catch (e) {
      console.error(e);
      done();
      ov(`<div class="chLogo">⚠️</div><h2>載入失敗</h2><p class="chDim">${esc(e.message || e)}</p><button class="chBtn main" onclick="location.reload()">再試</button>`, { full: true, close: false });
    }
  }
  function done() { const l = $id('chLoad'); if (l) l.remove(); }

  window.CH = { entitlement: () => entitlement(profile), canWrite, accountPage, upgradeCard, get profile() { return profile; }, get mode() { return PURE_LOCAL ? 'local' : CLOUD ? 'supabase' : 'dev'; }, api: null };
  start();
})();
