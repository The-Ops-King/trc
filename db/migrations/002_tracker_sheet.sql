-- The team's tracker sheet ("Tiffany Rose LEAP - 2026"), read daily. Read only: nothing is written back to the sheet.
--   sheet_ad_daily:    daily Facebook spend for the webinar campaigns (the sheet's FB Stats tab, "Tiffany Rose Standout" block)
--   sheet_webinar_day: per webinar day, from the monthly tabs: show-ups (typed in by the team) and the $97 lead-magnet sales
--                      (sold on the webinar, processed in an account this dashboard cannot reach)
create table trc.sheet_ad_daily (
  date        date primary key,
  spend_usd   numeric(12, 2) not null default 0,
  link_clicks bigint,
  impressions bigint,
  synced_at   timestamptz not null default now()
);

create table trc.sheet_webinar_day (
  date         date primary key,
  show_ups     int,
  lm_purchases int,
  lm_cash      numeric(12, 2),
  synced_at    timestamptz not null default now()
);

alter table trc.sheet_ad_daily enable row level security;
alter table trc.sheet_webinar_day enable row level security;

-- Ad numbers by day, one source per day: Meta when the Meta connection has that day, otherwise the tracker sheet.
-- So connecting Meta later takes over day by day and nothing is counted twice.
create view trc.ad_daily as
select date, sum(spend_usd) as spend_usd, sum(landing_page_views) as landing_page_views, sum(link_clicks) as link_clicks, 'meta'::text as source
from trc.meta_daily group by date
union all
select s.date, s.spend_usd, 0::bigint, coalesce(s.link_clicks, 0), 'sheet'
from trc.sheet_ad_daily s
where not exists (select 1 from trc.meta_daily m where m.date = s.date);
