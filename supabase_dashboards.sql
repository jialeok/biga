-- ============================================================================
-- 独立看板表：最近多板 + 早盘板块ETF表现
-- 目标：与 allData 全量加载解耦，各自原子化读写 Supabase，持久化 + 实时同步
-- 执行方式：在 Supabase Dashboard -> SQL Editor 中新建 Query 并 Run
-- ============================================================================

-- 1. 最近多板看板表（每日一行汇总）
create table if not exists recent_multi_data (
  date text primary key,
  shuliang text,                       -- 总数量
  die_count int,                       -- 跌家数（冗余，便于查询/统计）
  zhang_count int,                     -- 涨家数（冗余，便于查询/统计）
  die_zhangbi text,                    -- 跌涨比，格式 "跌:涨"
  jingtu text,                         -- 竞符合数
  tushi text,                          -- 图示/石墨链接
  comment text,                        -- 评论
  updated_at timestamptz default now()
);

comment on table recent_multi_data is '最近多板看板：每日汇总数据，独立表不依赖 allData';
comment on column recent_multi_data.die_zhangbi is '格式为 跌:涨，例如 42:24';

-- 2. 早盘板块ETF表现看板表（每日一行汇总）
create table if not exists early_etf_data (
  date text primary key,
  shuliang text,                       -- 总数量（默认 48）
  die_count int,                       -- 跌家数
  zhang_count int,                     -- 涨家数
  die_zhangbi text,                    -- 跌涨比，格式 "跌:涨"
  jingtu text,                         -- 竞符合数
  tushi text,                          -- 图示/石墨链接
  comment text,                        -- 评论
  sector_etf_close text,               -- 从竞价变化看板板块ETF(48)收盘同步的原始值
  sector_etf_synced_at timestamptz,    -- 最近一次同步时间
  updated_at timestamptz default now()
);

comment on table early_etf_data is '早盘板块ETF表现看板：每日汇总数据，独立表不依赖 allData';
comment on column early_etf_data.sector_etf_close is '来自 bidding_data 表中 name 包含"板块ETF"行的 close 字段';

-- 3. 开启行级安全（RLS）
alter table recent_multi_data enable row level security;
alter table early_etf_data enable row level security;

-- 4. RLS 策略：与现有 bidding_data/auction_data 保持一致，anon 全开放
--    如需改为仅认证用户可读写，请替换为 auth.uid() is not null 等策略
create policy "allow_all_recent_multi" on recent_multi_data
  for all to anon using (true) with check (true);

create policy "allow_all_early_etf" on early_etf_data
  for all to anon using (true) with check (true);

-- 5. 自动更新时间戳函数与触发器
--    更新任意字段时自动刷新 updated_at

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'trg_recent_multi_set_updated_at'
  ) then
    create trigger trg_recent_multi_set_updated_at
      before update on recent_multi_data
      for each row execute function public.set_updated_at();
  end if;

  if not exists (
    select 1 from pg_trigger where tgname = 'trg_early_etf_set_updated_at'
  ) then
    create trigger trg_early_etf_set_updated_at
      before update on early_etf_data
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- 6. 启用 Realtime（多设备同步）
--    若 supabase_realtime publication 不存在，先创建；否则直接加入表

do $$
begin
  if not exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) then
    create publication supabase_realtime;
  end if;
end $$;

alter publication supabase_realtime add table recent_multi_data;
alter publication supabase_realtime add table early_etf_data;
