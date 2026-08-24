-- Encontra rapidamente eventos de uma sessão e já devolve os mais recentes.
-- Igualdades primeiro; data/ordenação por último.
create index if not exists idx_lead_events_session_event_created_at_desc
  on public.lead_events (session_id, event_type, created_at desc);

-- Atualiza as estatísticas para o planejador usar o índice imediatamente.
analyze public.lead_events;
