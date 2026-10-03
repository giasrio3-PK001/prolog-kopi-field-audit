-- PROLOG KOPI — dashboard helper views
-- Run after the base schema and master data are available.

begin;

create or replace view public.sop_progress as
select
  s.code as sop_code,
  s.title as sop_title,
  s.indicator_count as target,
  count(i.id) as aktual,
  greatest(s.indicator_count - count(i.id), 0) as selisih,
  round(
    case
      when s.indicator_count = 0 then 0
      else count(i.id)::numeric / s.indicator_count::numeric * 100
    end,
    2
  ) as completion_percentage,
  case
    when count(i.id) = 0 then 'BELUM MULAI'
    when count(i.id) >= s.indicator_count then 'LENGKAP'
    else 'PROSES'
  end as status
from public.sops s
left join public.indicators i on i.sop_code = s.code
group by s.code, s.title, s.indicator_count
order by s.code;

create or replace view public.dashboard_sop_gaps as
select *
from public.sop_progress
where aktual < target
order by selisih desc, completion_percentage asc, sop_code;

create or replace view public.dashboard_summary as
select
  count(*) as total_sop,
  count(*) filter (where aktual >= target) as sop_lengkap,
  count(*) filter (where aktual > 0 and aktual < target) as sop_proses,
  count(*) filter (where aktual = 0) as sop_belum_mulai,
  sum(target) as total_target_indikator,
  sum(aktual) as total_aktual_indikator,
  sum(greatest(target - aktual, 0)) as total_gap,
  round(
    case
      when sum(target) = 0 then 0
      else sum(aktual)::numeric / sum(target)::numeric * 100
    end,
    2
  ) as master_completion_percentage
from public.sop_progress;

commit;
