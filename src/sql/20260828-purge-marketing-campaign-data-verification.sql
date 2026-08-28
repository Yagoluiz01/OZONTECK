select jsonb_build_object(
  'function_exists', to_regprocedure('public.purge_marketing_campaign_data(text)') is not null,
  'public_blocked', not has_function_privilege(
    'public',
    'public.purge_marketing_campaign_data(text)',
    'EXECUTE'
  ),
  'anon_blocked', not has_function_privilege(
    'anon',
    'public.purge_marketing_campaign_data(text)',
    'EXECUTE'
  ),
  'authenticated_blocked', not has_function_privilege(
    'authenticated',
    'public.purge_marketing_campaign_data(text)',
    'EXECUTE'
  ),
  'service_role_allowed', has_function_privilege(
    'service_role',
    'public.purge_marketing_campaign_data(text)',
    'EXECUTE'
  )
) as purge_security;
