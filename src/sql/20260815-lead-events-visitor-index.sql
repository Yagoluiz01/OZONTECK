-- Encontra rapidamente o histórico de um visitante sem varrer eventos de outras pessoas.
-- A igualdade vem primeiro e a data fica por último para também ajudar na ordenação.
create index if not exists idx_lead_events_visitor_created_at
  on public.lead_events (visitor_id, created_at);

-- Atualiza as estatísticas para o planejador usar o índice imediatamente.
analyze public.lead_events;
