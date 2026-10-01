/* 班級英雄 store：取代 localStorage／artifact publish 存檔路徑。
   store.init({adapter, uid})  →  store.load() → {data, version, updated_at} | null
   store.save(DB)              →  debounce 2 秒；離線排隊；上線補送；樂觀鎖 version 衝突 → onConflict(remote)
   adapters: local（本機，開發／離線測試）、supabase（classes 表 jsonb） */
(function () {
  'use strict';
  const DEBOUNCE = 2000, RETRY = 20000;
  const LS = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  class Conflict extends Error { constructor(remote) { super('conflict'); this.remote = remote; } }
  class Denied extends Error { constructor(m) { super(m || 'denied'); } }

  /* ---------- local adapter：一個 uid 一格，同樣有 version，所以兩個分頁都測到衝突 ---------- */
  function localAdapter(uid) {
    const K = 'ch_store:' + uid;
    return {
      name: 'local',
      async load() { return LS.get(K); },
      async save(data, baseVersion) {
        const cur = LS.get(K);
        if (cur && cur.version !== baseVersion) throw new Conflict(cur);
        const rec = { id: 'local', data, version: (cur ? cur.version : 0) + 1, updated_at: new Date().toISOString() };
        if (!LS.set(K, rec)) throw new Error('localStorage full');
        return rec;
      },
      async forceBase() { const c = LS.get(K); return c ? c.version : 0; }
    };
  }

  /* ---------- supabase adapter：classes(id, owner, data jsonb, updated_at, version) ---------- */
  function supabaseAdapter(sb, uid) {
    let rowId = null;
    const isDenied = e => e && (e.code === '42501' || /row-level security|permission/i.test(e.message || ''));
    return {
      name: 'supabase',
      async load() {
        const { data, error } = await sb.from('classes').select('id,data,version,updated_at')
          .eq('owner', uid).order('updated_at', { ascending: false }).limit(1);
        if (error) throw error;
        if (!data || !data.length) return null;
        rowId = data[0].id; return data[0];
      },
      async save(payload, baseVersion) {
        if (!rowId) {
          const { data, error } = await sb.from('classes').insert({ owner: uid, data: payload, version: 1 })
            .select('id,version,updated_at').single();
          if (error) { if (isDenied(error)) throw new Denied(); throw error; }
          rowId = data.id; return Object.assign({ data: payload }, data);
        }
        const { data, error } = await sb.from('classes')
          .update({ data: payload, version: baseVersion + 1, updated_at: new Date().toISOString() })
          .eq('id', rowId).eq('version', baseVersion).select('id,version,updated_at');
        if (error) { if (isDenied(error)) throw new Denied(); throw error; }
        if (!data || !data.length) {           // 0 行 = 版本唔啱（或者 RLS 拒絕）
          const remote = await this.load();
          if (remote && remote.version !== baseVersion) throw new Conflict(remote);
          throw new Denied();
        }
        return Object.assign({ data: payload }, data[0]);
      }
    };
  }

  const store = {
    adapter: null, uid: null, version: 0, updated_at: null,
    status: '', timer: null, busy: false, pendingKey: null,
    onStatus: () => {}, onConflict: null, onDenied: null,
    adapters: { local: localAdapter, supabase: supabaseAdapter },
    Conflict, Denied,

    init(adapter, uid) {
      this.adapter = adapter; this.uid = uid; this.pendingKey = 'ch_pending:' + uid;
      addEventListener('online', () => this.flush());
      setInterval(() => { if (LS.get(this.pendingKey)) this.flush(); }, RETRY);
      addEventListener('beforeunload', e => {
        if (LS.get(this.pendingKey) && !navigator.onLine) { e.preventDefault(); e.returnValue = ''; }
      });
    },
    async load() {
      const rec = await this.adapter.load();
      const pend = LS.get(this.pendingKey);
      if (rec) { this.version = rec.version; this.updated_at = rec.updated_at; }
      // 上次離線未送出嘅改動：只有基於同一個版本先自動補送，否則交俾衝突流程
      if (pend && pend.data) {
        if (!rec || pend.base === rec.version) { this.flushSoon(); return { data: pend.data, version: this.version, pending: true }; }
        this.flushSoon();                     // 基於舊版本 → 送出時會觸發衝突提示，由老師揀
      }
      return rec;
    },
    save(DB) {
      LS.set(this.pendingKey, { data: JSON.parse(JSON.stringify(DB)), base: this.version, at: Date.now() });
      this.setStatus(navigator.onLine ? '💾 待儲存…' : '📴 離線：已排隊');
      this.flushSoon();
    },
    flushSoon() { clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), DEBOUNCE); },
    async flush() {
      if (this.busy) { this.flushSoon(); return; }
      const pend = LS.get(this.pendingKey); if (!pend) return;
      if (!navigator.onLine) { this.setStatus('📴 離線：已排隊'); return; }
      this.busy = true; this.setStatus('☁️ 儲存中…');
      try {
        const rec = await this.adapter.save(pend.data, pend.base);
        this.version = rec.version; this.updated_at = rec.updated_at;
        const now = LS.get(this.pendingKey);            // 送緊期間有冇新改動？
        if (now && now.at === pend.at) LS.del(this.pendingKey);
        else if (now) { now.base = this.version; LS.set(this.pendingKey, now); this.flushSoon(); }
        this.setStatus('☁️ 已儲存');
      } catch (e) {
        if (e instanceof Conflict) { this.setStatus('⚠️ 有衝突'); if (this.onConflict) this.onConflict(e.remote); }
        else if (e instanceof Denied) { this.setStatus('🔒 唯讀'); LS.del(this.pendingKey); if (this.onDenied) this.onDenied(); }
        else { this.setStatus('📴 未能儲存，稍後重試'); }
      } finally { this.busy = false; }
    },
    /* 衝突：用戶揀「保留呢部機」→ 以遠端版本做 base 再送 */
    async keepMine(remote) { this.version = remote.version; const p = LS.get(this.pendingKey); if (p) { p.base = remote.version; LS.set(this.pendingKey, p); } return this.flush(); },
    pendingData() { const p = LS.get(this.pendingKey); return p ? p.data : null; },
    dropPending() { LS.del(this.pendingKey); },
    setStatus(t) { this.status = t; try { this.onStatus(t); } catch (e) {} }
  };
  window.store = store;
})();
