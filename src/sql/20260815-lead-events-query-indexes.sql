-- Evita ordenar e varrer todo o histórico para mostrar os eventos mais recentes.
create index if not exists idx_lead_events_created_at_desc
  on public.lead_events (created_at desc);

-- Acelera consultas por tipo de evento dentro de um período.
-- A coluna de igualdade vem antes da coluna de data/range.
create index if not exists idx_lead_events_event_type_created_at_desc
  on public.lead_events (event_type, created_at desc);

-- Atualiza as estatísticas para o planejador usar os índices imediatamente.
analyze public.lead_events;
