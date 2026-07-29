-- ============================================================================
-- 早盘竞价看板三表拆分：auction_watchlist / hot_stocks / market_metrics
-- 目标：彻底分离"主列表"与"市场指标/影子数据"，根治历史日期被影子记录污染
-- 执行方式：在 Supabase Dashboard -> SQL Editor 中新建 Query 并 Run
-- ============================================================================

-- 1. 早盘竞价主列表（正式列表成员）
create table if not exists auction_watchlist (
  date text not null,
  stock text not null,
  code text,
  volume text,
  yest_volume text,
  note text,
  change_pct text,
  topics text,
  source text default 'manual',           -- manual | worker | observation | holding | import
  obs_auto_added boolean default false,   -- 观察组自动继承标记
  selected boolean default false,         -- 已废弃，仅兼容旧数据
  bought boolean default false,           -- 已废弃，仅兼容旧数据
  sold boolean default false,             -- 已废弃，仅兼容旧数据
  fixed boolean default false,            -- 已废弃，仅兼容旧数据
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  updated_by text,
  primary key (date, stock)
);

comment on table auction_watchlist is '早盘竞价主列表：只存当天正式展示的股票，无 in_watchlist 字段（表中每一行天然是正式成员）';

-- 2. 市场指标/影子数据（早盘竞价 + 热门股票共用）
-- 必须先创建 market_metrics，后续 hot_stocks 兼容迁移才能向其中插入影子记录
create table if not exists market_metrics (
  date text not null,
  stock text not null,
  code text,
  volume text,
  yest_volume text,
  change_pct text,
  time930 text,
  seal_count text,
  scope text not null default 'auction',  -- 'auction' | 'hot'，区分属于哪个 tab
  source text default 'manual',           -- ths_api | manual_fill | computed | worker
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  updated_by text,
  primary key (date, stock, scope)
);

comment on table market_metrics is '市场指标/影子数据：早盘竞价和热门股票共用，按 scope 区分来源，不进入任何主列表';

-- 2.5 一次性迁移：把旧 auction_data 表数据拆分到 auction_watchlist 与 market_metrics(scope='auction')
-- 旧 auction_data 列结构可能不齐，这里只引用它一定存在的列（date,stock,code,volume,yest_volume,
-- note,change_pct,topics,in_watchlist,selected,bought,sold,fixed）；source / obs_auto_added 直接给
-- 默认值，避免 42703 列不存在错误。用 EXECUTE + to_regclass 避免编译期 relation 错误。
do $$
declare
  _auction_data_exists boolean := false;
  _watchlist_count int := 0;
begin
  if to_regclass('public.auction_data') is not null then
    _auction_data_exists := true;
  end if;

  if to_regclass('public.auction_watchlist') is not null then
    select count(*) into _watchlist_count from auction_watchlist;
  end if;

  -- 只有旧表存在且新表为空时才迁移，避免重复执行或覆盖新数据
  if _auction_data_exists and _watchlist_count = 0 then
    execute $mig_wl$
      insert into auction_watchlist (date, stock, code, volume, yest_volume, note, change_pct, topics, source, obs_auto_added, selected, bought, sold, fixed, updated_at, updated_by)
      select date, stock, code, volume, yest_volume, note, change_pct, topics,
             'manual', false,
             coalesce(selected, false), coalesce(bought, false), coalesce(sold, false), coalesce(fixed, false),
             now(), 'sql_migrate'
      from auction_data
      where in_watchlist = true
        and not exists (
          select 1 from auction_watchlist aw
          where aw.date = auction_data.date and aw.stock = auction_data.stock
        )
    $mig_wl$;

    execute $mig_mm$
      insert into market_metrics (date, stock, code, volume, yest_volume, change_pct, scope, source, updated_at, updated_by)
      select date, stock, code, volume, yest_volume, change_pct, 'auction',
             'manual',
             now(), 'sql_migrate'
      from auction_data
      where (in_watchlist = false or in_watchlist is null)
        and not exists (
          select 1 from market_metrics mm
          where mm.date = auction_data.date and mm.stock = auction_data.stock and mm.scope = 'auction'
        )
    $mig_mm$;

    raise notice '已把旧 auction_data 拆分到 auction_watchlist / market_metrics(scope=auction)';
  end if;
end $$;

-- 3. 辅助索引：按 scope+date 快速查询某天的全部指标
create index if not exists idx_market_metrics_scope_date on market_metrics(scope, date);

-- 1.5 热门股票主列表（正式列表成员，无 in_watchlist 列，每行天然是正式成员）
-- 先迁移旧 hot_stocks 表中可能存在的 in_watchlist=false 影子记录到 market_metrics(scope='hot')
-- 使用 EXECUTE 动态 SQL + 表存在性校验，避免 PL/pgSQL 编译期报 relation does not exist
-- （兼容旧表结构，幂等执行）
do $$
begin
  -- 若 market_metrics 尚未创建（例如用户只执行了脚本片段），直接跳过迁移
  if to_regclass('public.market_metrics') is null then
    return;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'hot_stocks' and column_name = 'in_watchlist'
  ) then
    execute $mig$
      insert into market_metrics (date, stock, code, volume, yest_volume, change_pct, scope, source, updated_at, updated_by)
      select date, stock, coalesce(code, ''), volume, yest_volume, change_pct, 'hot', 'sql_migrate_shadow', now(), 'sql_migrate_shadow'
      from hot_stocks
      where in_watchlist = false
        and not exists (
          select 1 from market_metrics mm
          where mm.date = hot_stocks.date and mm.stock = hot_stocks.stock and mm.scope = 'hot'
        )
    $mig$;

    execute $del$ delete from hot_stocks where in_watchlist = false $del$;
    execute $alter$ alter table hot_stocks drop column if exists in_watchlist $alter$;
  end if;
end $$;

create table if not exists hot_stocks (
  date text not null,
  stock text not null,
  code text,
  volume text,
  yest_volume text,
  note text,
  change_pct text,
  topics text,
  source text default 'manual',           -- manual | worker | observation | holding | import
  obs_auto_added boolean default false,   -- 观察组自动继承标记
  selected boolean default false,         -- 已废弃，仅兼容旧数据
  bought boolean default false,           -- 已废弃，仅兼容旧数据
  sold boolean default false,             -- 已废弃，仅兼容旧数据
  fixed boolean default false,            -- 已废弃，仅兼容旧数据
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  updated_by text,
  primary key (date, stock)
);

comment on table hot_stocks is '热门股票主列表：只存当天正式展示的股票，无 in_watchlist 字段（表中每一行天然是正式成员）';

-- 4. 行级安全（RLS）：与现有 bidding_data/auction_data 保持一致，anon 全开放
alter table auction_watchlist enable row level security;
alter table hot_stocks enable row level security;
alter table market_metrics enable row level security;

-- PostgreSQL 没有 create policy if not exists，用 DO 块幂等创建
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'auction_watchlist' and policyname = 'allow_all_auction_watchlist') then
    create policy "allow_all_auction_watchlist" on auction_watchlist
      for all to anon using (true) with check (true);
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'hot_stocks' and policyname = 'allow_all_hot_stocks') then
    create policy "allow_all_hot_stocks" on hot_stocks
      for all to anon using (true) with check (true);
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'market_metrics' and policyname = 'allow_all_market_metrics') then
    create policy "allow_all_market_metrics" on market_metrics
      for all to anon using (true) with check (true);
  end if;
end $$;

-- 5. 自动更新时间戳触发器
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_auction_watchlist_set_updated_at') then
    create trigger trg_auction_watchlist_set_updated_at
      before update on auction_watchlist
      for each row execute function public.set_updated_at();
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'trg_market_metrics_set_updated_at') then
    create trigger trg_market_metrics_set_updated_at
      before update on market_metrics
      for each row execute function public.set_updated_at();
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'trg_hot_stocks_set_updated_at') then
    create trigger trg_hot_stocks_set_updated_at
      before update on hot_stocks
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- 6. 启用 Realtime（供多端同步）
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

-- 幂等添加表到 publication（已存在则跳过，避免重复报错）
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'auction_watchlist') then
    alter publication supabase_realtime add table auction_watchlist;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'market_metrics') then
    alter publication supabase_realtime add table market_metrics;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'hot_stocks') then
    alter publication supabase_realtime add table hot_stocks;
  end if;
end $$;
