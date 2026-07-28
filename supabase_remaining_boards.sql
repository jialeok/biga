-- ============================================================================
-- 剩余看板独立拆表：stocks / rank / multi / hotspot / pattern / tag_titles
-- 目标：完全脱离 allData 全量加载，各自原子化读写 Supabase
-- 执行方式：在 Supabase Dashboard -> SQL Editor 中新建 Query 并 Run
-- ============================================================================

-- 1. 热股/主股票列表（按日期 + 股票名拆行）
create table if not exists stocks_data (
  date text not null,
  name text not null,
  local_id bigint,
  stage text,
  adjust text,
  open text,
  close text,
  turnover text,
  kbiliangkai text,
  sfliangneng text,
  xgcaiti text,
  next_day text,
  bomb boolean default false,
  bought boolean default false,
  sold boolean default false,
  sell_high boolean default false,
  sell_1120 boolean default false,
  sell_1450 boolean default false,
  hold boolean default false,
  watch boolean default false,
  dragon boolean default false,
  pattern text,
  axis text,
  comment text,
  remark text,
  remark_type text,
  track jsonb default '[]'::jsonb,
  sold_records jsonb default '[]'::jsonb,
  is_sold boolean default false,
  recent_multi boolean default false,
  topic_direction boolean default false,
  sector_etf boolean default false,
  nishi boolean default false,
  shunshi boolean default false,
  inherited_hold boolean,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  primary key (date, name)
);

comment on table stocks_data is '热股/主股票列表：按日期 + 股票名独立拆行，不依赖 allData';

-- 2. 昨日最大成交额看板（每日一行 JSON）
create table if not exists rank_data (
  date text primary key,
  data jsonb not null default '[]'::jsonb,
  updated_at timestamptz default now()
);

comment on table rank_data is '昨日最大成交额看板：每日一行，data 为行数组';

-- 3. 题材分类看板（每日一行 JSON）
create table if not exists multi_data (
  date text primary key,
  data jsonb not null default '[]'::jsonb,
  updated_at timestamptz default now()
);

comment on table multi_data is '题材分类看板：每日一行，data 为行数组';

-- 4. 题材思路看板（每日一行文本）
create table if not exists hotspot_data (
  date text primary key,
  content text not null default '',
  updated_at timestamptz default now()
);

comment on table hotspot_data is '题材思路看板：每日一行文本';

-- 5. 模式看板（每日一行）
create table if not exists pattern_data (
  date text primary key,
  content text not null default '',
  update_flag boolean not null default false,
  keep_flag boolean not null default false,
  updated_at timestamptz default now()
);

comment on table pattern_data is '模式看板：每日一行，含 update/keep 标签';

-- 6. 标签标题看板（每日一行 JSON，含三种类型）
create table if not exists tag_titles_data (
  date text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now()
);

comment on table tag_titles_data is '标签标题看板：每日一行，data 含 recentMulti/sectorEtf/topicDirection';

-- 7. 行级安全（RLS）
alter table stocks_data enable row level security;
alter table rank_data enable row level security;
alter table multi_data enable row level security;
alter table hotspot_data enable row level security;
alter table pattern_data enable row level security;
alter table tag_titles_data enable row level security;

create policy "allow_all_stocks" on stocks_data for all to anon using (true) with check (true);
create policy "allow_all_rank" on rank_data for all to anon using (true) with check (true);
create policy "allow_all_multi" on multi_data for all to anon using (true) with check (true);
create policy "allow_all_hotspot" on hotspot_data for all to anon using (true) with check (true);
create policy "allow_all_pattern" on pattern_data for all to anon using (true) with check (true);
create policy "allow_all_tag_titles" on tag_titles_data for all to anon using (true) with check (true);

-- 8. 自动更新时间戳触发器（确保函数存在，再绑定触发器）
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_stocks_set_updated_at') then
    create trigger trg_stocks_set_updated_at
      before update on stocks_data
      for each row execute function public.set_updated_at();
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'trg_rank_set_updated_at') then
    create trigger trg_rank_set_updated_at
      before update on rank_data
      for each row execute function public.set_updated_at();
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'trg_multi_set_updated_at') then
    create trigger trg_multi_set_updated_at
      before update on multi_data
      for each row execute function public.set_updated_at();
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'trg_hotspot_set_updated_at') then
    create trigger trg_hotspot_set_updated_at
      before update on hotspot_data
      for each row execute function public.set_updated_at();
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'trg_pattern_set_updated_at') then
    create trigger trg_pattern_set_updated_at
      before update on pattern_data
      for each row execute function public.set_updated_at();
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'trg_tag_titles_set_updated_at') then
    create trigger trg_tag_titles_set_updated_at
      before update on tag_titles_data
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- 9. 辅助索引
create index if not exists idx_stocks_date on stocks_data (date);
create index if not exists idx_stocks_local_id on stocks_data (local_id);

-- 10. 启用 Realtime
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

-- 幂等添加表到 publication（已存在则跳过，避免重复报错）
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'stocks_data') then
    alter publication supabase_realtime add table stocks_data;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'rank_data') then
    alter publication supabase_realtime add table rank_data;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'multi_data') then
    alter publication supabase_realtime add table multi_data;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'hotspot_data') then
    alter publication supabase_realtime add table hotspot_data;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'pattern_data') then
    alter publication supabase_realtime add table pattern_data;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'tag_titles_data') then
    alter publication supabase_realtime add table tag_titles_data;
  end if;
end $$;
