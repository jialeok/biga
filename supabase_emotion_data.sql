-- ============================================================================
-- 情绪看板表：每日一条记录，存储猫爪情绪周期接口抓取的 5 日指标
-- 目标：早盘 9:26 自动抓取，前端点击标题栏展开近 5 日趋势图
-- 执行方式：在 Supabase Dashboard -> SQL Editor 中新建 Query 并 Run
-- ============================================================================

-- 1. 情绪看板表（每日一行汇总）
create table if not exists emotion_data (
  date text primary key,
  metrics jsonb default '{}'::jsonb,    -- 当日主要指标：amount（成交额/元）、limit_up、limit_down 等
  five_days jsonb default '[]'::jsonb, -- 近 5 个交易日原始数据数组，按日期升序
  api_fields text[],                    -- 本次抓取接口返回的字段名列表（便于调试字段映射）
  updated_at timestamptz default now()
);

comment on table emotion_data is '情绪看板：每日抓取猫爪情绪周期接口，存储当日指标与近5日趋势';
comment on column emotion_data.metrics is '当日情绪指标对象，字段见 CONFIG.EMOTION_FIELDS 映射';
comment on column emotion_data.five_days is '近5个交易日原始 items 数组，前端据此绘制趋势图';
comment on column emotion_data.api_fields is '接口返回字段名快照，便于首次运行时核对字段映射';

-- 2. 开启行级安全（RLS）
alter table emotion_data enable row level security;

-- 3. RLS 策略：与现有 bidding_data/jiwang_data 保持一致，anon 全开放
--    如需改为仅认证用户可读写，请替换为 auth.uid() is not null 等策略
create policy "allow_all_emotion" on emotion_data
  for all to anon using (true) with check (true);

-- 4. 自动更新时间戳函数（如不存在则创建）
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- 5. 触发器：更新时自动刷新 updated_at
do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'trg_emotion_set_updated_at'
  ) then
    create trigger trg_emotion_set_updated_at
      before update on emotion_data
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- 6. 启用 Realtime（多设备同步）
do $$
begin
  if not exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) then
    create publication supabase_realtime;
  end if;
end $$;

alter publication supabase_realtime add table emotion_data;
