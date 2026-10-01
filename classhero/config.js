/* 班級英雄 SaaS 設定。SUPABASE_URL／ANON_KEY 留空 → 自動用本機 (local) adapter，完全離線可用。
   ANON_KEY 係公開 key（靠 RLS 保護），可以放前端；STRIPE_SECRET_KEY 千祈唔好放呢度。 */
window.CH_CONFIG = {
  SUPABASE_URL: 'https://rkqtivbzdxgbcnzekkci.supabase.co',                       // 例：https://abcdefgh.supabase.co
  SUPABASE_ANON_KEY: 'sb_publishable_xkegoxxNAqF8WTdAimTLLw_V2LN-ssq',                  // Supabase → Project Settings → API → anon public
  STRIPE_PRICE_TEACHER_MONTHLY: '',       // 例：price_1Q...（HK$38／月）
  STRIPE_PRICE_SCHOOL_SEAT_YEARLY: '',    // 例：price_1Q...（HK$300／位／年）
  TRIAL_DAYS: 14,
  DEV_FAKE_AUTH: false                    // true = 本機假帳戶（測試登入／試用／唯讀／學校頁，唔使 Supabase）
};
