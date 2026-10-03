-- Go-live guide, step B3: did the six setup scripts work?
-- Expected: one row — 100 | 2 | false
select
  (select credits_included from plan_catalogue where plan = 'sandbox') as sandbox_credits,
  (select count(*) from information_schema.columns
     where table_name = 'accounts'
       and column_name in ('data_region', 'zero_retention')) as new_columns,
  has_function_privilege('anon', 'billing_apply_credits(uuid,int,text)', 'execute')
    as anyone_can_add_credits;
