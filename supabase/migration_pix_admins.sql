-- ============================================================
-- Cadastra os PIX (caixas) dos 3 administradores:
-- Philippe Norman, Felipe Freitas e Felipe Muniz.
--
-- Felipe Freitas já entra com a chave (duostudiophoto@gmail.com) e continua
-- sendo o PIX do mês. Philippe Norman e Felipe Muniz entram SEM chave —
-- completem em Pagamentos → PIX do mês → "editar". Enquanto estiverem sem
-- chave, não dá pra escolher esses PIX como conta do mês.
--
-- Rode inteiro no SQL Editor do Supabase. Não duplica ninguém se rodar de
-- novo, e não mexe em PIX que já estejam cadastrados.
-- ============================================================

do $$
declare
  cur jsonb;
  accs jsonb;
  active text;
begin
  select value into cur from app_settings where key = 'pix_settings';
  accs := coalesce(cur->'accounts', '[]'::jsonb);
  active := cur->>'activeId';

  -- Felipe Freitas (PIX padrão, já usado nas cobranças)
  if not exists (
    select 1 from jsonb_array_elements(accs) a
    where lower(trim(a->>'key')) = 'duostudiophoto@gmail.com'
       or lower(a->>'name') like '%felipe%freitas%'
  ) then
    accs := jsonb_build_array(jsonb_build_object(
      'id', 'pix-padrao', 'name', 'Felipe Freitas', 'key', 'duostudiophoto@gmail.com'
    )) || accs;
  end if;

  -- Philippe Norman
  if not exists (
    select 1 from jsonb_array_elements(accs) a where lower(a->>'name') like '%philippe%norman%'
  ) then
    accs := accs || jsonb_build_array(jsonb_build_object(
      'id', 'pix-philippe-norman', 'name', 'Philippe Norman', 'key', ''
    ));
  end if;

  -- Felipe Muniz
  if not exists (
    select 1 from jsonb_array_elements(accs) a where lower(a->>'name') like '%felipe%muniz%'
  ) then
    accs := accs || jsonb_build_array(jsonb_build_object(
      'id', 'pix-felipe-muniz', 'name', 'Felipe Muniz', 'key', ''
    ));
  end if;

  -- Conta do mês: mantém a atual; se não tiver (ou não existir mais),
  -- fica a do Felipe Freitas.
  if active is null or not exists (
    select 1 from jsonb_array_elements(accs) a where a->>'id' = active
  ) then
    select a->>'id' into active
    from jsonb_array_elements(accs) a
    where lower(trim(a->>'key')) = 'duostudiophoto@gmail.com'
       or lower(a->>'name') like '%felipe%freitas%'
    limit 1;
  end if;

  insert into app_settings (key, value)
  values ('pix_settings', jsonb_build_object('accounts', accs, 'activeId', active))
  on conflict (key) do update set value = excluded.value;
end $$;
