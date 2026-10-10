-- ============================================================
-- Pelada 4K — schema do Supabase
-- Cole este arquivo inteiro no SQL Editor do seu projeto Supabase
-- (Project → SQL Editor → New query) e clique em "Run".
-- ============================================================

-- Tabela de jogadores -----------------------------------------------------
create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  nickname text,
  rating integer not null default 7,
  is_gk boolean not null default false,
  photo_url text,
  photo_position text default '50% 50%',
  cover1_url text,
  cover2_url text,
  cover3_url text,
  position text,
  favorite_team text,
  created_at timestamptz not null default now()
);

alter table players enable row level security;

-- Se você já rodou este arquivo antes (versão sem "photo_position"), esta
-- linha adiciona a coluna nova sem apagar nada do que já existe.
alter table players add column if not exists photo_position text default '50% 50%';

-- Carrossel de fotos de capa do card foi de 3 pra 5 fotos — colunas novas
-- pra quem já tinha rodado este arquivo antes.
alter table players add column if not exists cover4_url text;
alter table players add column if not exists cover5_url text;

-- Qualquer pessoa (mesmo sem login) pode VER o elenco — necessário pra
-- selecionar jogadores e sortear os times.
drop policy if exists "select_players_public" on players;
create policy "select_players_public"
  on players for select
  to anon, authenticated
  using (true);

-- Só quem estiver logado como administrador pode cadastrar / editar / excluir.
drop policy if exists "insert_players_admin" on players;
create policy "insert_players_admin"
  on players for insert
  to authenticated
  with check (true);

drop policy if exists "update_players_admin" on players;
create policy "update_players_admin"
  on players for update
  to authenticated
  using (true);

drop policy if exists "delete_players_admin" on players;
create policy "delete_players_admin"
  on players for delete
  to authenticated
  using (true);

-- Storage: bucket público para as fotos dos jogadores ---------------------
insert into storage.buckets (id, name, public)
values ('player-photos', 'player-photos', true)
on conflict (id) do nothing;

drop policy if exists "select_player_photos_public" on storage.objects;
create policy "select_player_photos_public"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'player-photos');

drop policy if exists "insert_player_photos_admin" on storage.objects;
create policy "insert_player_photos_admin"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'player-photos');

drop policy if exists "update_player_photos_admin" on storage.objects;
create policy "update_player_photos_admin"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'player-photos');

drop policy if exists "delete_player_photos_admin" on storage.objects;
create policy "delete_player_photos_admin"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'player-photos');

-- ============================================================
-- Login individual — administradores x usuários comuns
-- ============================================================
-- A partir daqui: qualquer pessoa pode criar uma conta (e-mail/senha) pelo
-- próprio app. Isso NÃO torna ninguém administrador automaticamente — quem
-- é admin é só quem estiver na tabela "admins" abaixo. Depois de rodar este
-- arquivo, crie sua conta normalmente pelo app e depois rode manualmente,
-- trocando pelo seu e-mail:
--
--   insert into admins (user_id)
--   select id from auth.users where email = 'seu-email@exemplo.com';

-- Tabela de administradores -------------------------------------------------
create table if not exists admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table admins enable row level security;

drop policy if exists "select_admins_self" on admins;
create policy "select_admins_self"
  on admins for select
  to authenticated
  using (user_id = auth.uid());

-- Função auxiliar: true se quem está logado é administrador. security
-- definer pra poder checar a tabela "admins" sem cair em recursão de RLS.
create or replace function is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (select 1 from admins where user_id = auth.uid());
$$;

-- Um admin já existente pode ver, promover e remover outros administradores
-- direto pelo app (tela "👑 administradores"), sem precisar mexer em SQL.
drop policy if exists "select_admins_admin" on admins;
create policy "select_admins_admin"
  on admins for select
  to authenticated
  using (is_admin());

drop policy if exists "insert_admins_admin" on admins;
create policy "insert_admins_admin"
  on admins for insert
  to authenticated
  with check (is_admin());

drop policy if exists "delete_admins_admin" on admins;
create policy "delete_admins_admin"
  on admins for delete
  to authenticated
  using (is_admin());

-- Perfis — criado automaticamente para toda conta nova (gatilho abaixo).
-- É como o administrador enxerga "quem se cadastrou e ainda não tem card
-- vinculado" pra poder direcionar o login certo pro jogador certo.
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  created_at timestamptz not null default now()
);
alter table profiles enable row level security;

drop policy if exists "select_profiles_admin" on profiles;
create policy "select_profiles_admin"
  on profiles for select
  to authenticated
  using (is_admin() or id = auth.uid());

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- Backfill: preenche "profiles" pra qualquer conta que já existia ANTES
-- desse gatilho (senão ela nunca aparece no dropdown de "vincular login" do
-- admin, mesmo a pessoa já tendo se cadastrado). Seguro rodar de novo
-- sempre que colar este arquivo — só insere quem ainda estiver faltando.
insert into public.profiles (id, email, full_name)
select id, email, raw_user_meta_data->>'full_name'
from auth.users
on conflict (id) do nothing;

-- Vínculo entre o login e o card do jogador --------------------------------
alter table players add column if not exists user_id uuid unique references auth.users(id) on delete set null;

-- Instagram pessoal (público, aparece pra todo mundo no card) — guardado
-- sem o "@", o app adiciona na hora de exibir. Não é uma coluna "trancada"
-- pelo gatilho abaixo, então o próprio jogador pode editar o dele.
alter table players add column if not exists instagram text;

-- Usuário comum só pode alterar o PRÓPRIO card (o admin pode alterar
-- qualquer um). As colunas "sensíveis" (nome, nota, goleiro, posição, time
-- do coração e o próprio vínculo) ficam travadas por gatilho pra usuário
-- comum mesmo que tente forçar via API — só quem edita isso é o admin.
drop policy if exists "update_players_admin" on players;
drop policy if exists "update_players_self" on players;
create policy "update_players_admin"
  on players for update
  to authenticated
  using (is_admin())
  with check (is_admin());
create policy "update_players_self"
  on players for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create or replace function lock_player_protected_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_admin() then
    new.name := old.name;
    new.rating := old.rating;
    new.is_gk := old.is_gk;
    new.position := old.position;
    new.favorite_team := old.favorite_team;
    new.user_id := old.user_id;
  end if;
  return new;
end;
$$;

drop trigger if exists lock_player_protected_fields_trg on players;
create trigger lock_player_protected_fields_trg
  before update on players
  for each row execute function lock_player_protected_fields();

-- ============================================================
-- Controle de pagamento — mensalidade (mensalista) e pagamento avulso
-- (por pelada), e o interruptor de bloqueio de inadimplente
-- ============================================================

-- "paid" na presença: controla o pagamento do avulso NAQUELA pelada
-- específica (some sozinho quando uma nova pelada é publicada, porque as
-- presenças são por pelada). Só admin marca — travado por gatilho.
alter table presences add column if not exists paid boolean not null default false;

create or replace function lock_presence_paid_field()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_admin() then
    if tg_op = 'INSERT' then
      new.paid := false;
    else
      new.paid := old.paid;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists lock_presence_paid_trg on presences;
create trigger lock_presence_paid_trg
  before insert or update on presences
  for each row execute function lock_presence_paid_field();

-- Mensalidade: um registro por mensalista por mês ('YYYY-MM'). Só admin
-- grava; o próprio mensalista só lê o dele (pra saber se está liberado).
create table if not exists membership_payments (
  player_id uuid not null references players(id) on delete cascade,
  month text not null,
  paid boolean not null default false,
  paid_at timestamptz,
  updated_by uuid references auth.users(id),
  primary key (player_id, month)
);
alter table membership_payments enable row level security;

drop policy if exists "select_membership_payments_admin_or_self" on membership_payments;
create policy "select_membership_payments_admin_or_self"
  on membership_payments for select
  to authenticated
  using (is_admin() or player_id in (select id from players where user_id = auth.uid()));

drop policy if exists "write_membership_payments_admin" on membership_payments;
create policy "write_membership_payments_admin"
  on membership_payments for all
  to authenticated
  using (is_admin())
  with check (is_admin());

-- Configurações gerais do app (chave/valor). Usado pro interruptor "bloquear
-- acesso à lista de mensalista inadimplente" — qualquer um lê (precisa saber
-- se o próprio acesso está travado), só admin altera.
create table if not exists app_settings (
  key text primary key,
  value jsonb not null
);
alter table app_settings enable row level security;

drop policy if exists "select_app_settings_public" on app_settings;
create policy "select_app_settings_public"
  on app_settings for select
  to anon, authenticated
  using (true);

drop policy if exists "write_app_settings_admin" on app_settings;
create policy "write_app_settings_admin"
  on app_settings for all
  to authenticated
  using (is_admin())
  with check (is_admin());

-- Cadastrar/excluir jogadores do elenco continua sendo só pra admin de
-- verdade (antes valia pra qualquer autenticado; agora existem usuários
-- comuns autenticados também, então isso precisa ser restrito).
drop policy if exists "insert_players_admin" on players;
create policy "insert_players_admin"
  on players for insert
  to authenticated
  with check (is_admin());

drop policy if exists "delete_players_admin" on players;
create policy "delete_players_admin"
  on players for delete
  to authenticated
  using (is_admin());

-- ============================================================
-- Próxima pelada — lista de presença (RSVP)
-- ============================================================
create table if not exists peladas (
  id uuid primary key default gen_random_uuid(),
  scheduled_for timestamptz,
  location text,
  status text not null default 'open' check (status in ('open', 'closed')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
alter table peladas enable row level security;

drop policy if exists "select_peladas_public" on peladas;
create policy "select_peladas_public"
  on peladas for select
  to anon, authenticated
  using (true);

drop policy if exists "insert_peladas_admin" on peladas;
create policy "insert_peladas_admin"
  on peladas for insert
  to authenticated
  with check (is_admin());

drop policy if exists "update_peladas_admin" on peladas;
create policy "update_peladas_admin"
  on peladas for update
  to authenticated
  using (is_admin())
  with check (is_admin());

drop policy if exists "delete_peladas_admin" on peladas;
create policy "delete_peladas_admin"
  on peladas for delete
  to authenticated
  using (is_admin());

-- "player_id" identifica um jogador do elenco (mensalista); "guest_name" é
-- usado só para AVULSO (gente de fora do elenco que o admin inclui na lista
-- de uma pelada específica) — uma linha tem sempre exatamente um dos dois.
-- "status" guarda se é presença confirmada ou ausência marcada; avulso só
-- existe como 'confirmed' (não faz sentido "avulso ausente").
create table if not exists presences (
  id uuid primary key default gen_random_uuid(),
  pelada_id uuid not null references peladas(id) on delete cascade,
  player_id uuid references players(id) on delete cascade,
  guest_name text,
  status text not null default 'confirmed',
  confirmed_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  constraint presences_one_of_player_or_guest
    check ((player_id is not null) <> (guest_name is not null)),
  constraint presences_status_check check (status in ('confirmed', 'absent')),
  constraint presences_guest_always_confirmed
    check (player_id is not null or status = 'confirmed')
);
alter table presences enable row level security;

-- Se você já tinha rodado uma versão anterior deste arquivo (sem ausência/
-- avulso), estes comandos atualizam a tabela existente sem apagar nada.
alter table presences alter column player_id drop not null;
alter table presences add column if not exists guest_name text;
alter table presences add column if not exists status text not null default 'confirmed';
alter table presences drop constraint if exists presences_pelada_id_player_id_key;
alter table presences drop constraint if exists presences_one_of_player_or_guest;
alter table presences add constraint presences_one_of_player_or_guest
  check ((player_id is not null) <> (guest_name is not null));
alter table presences drop constraint if exists presences_status_check;
alter table presences add constraint presences_status_check check (status in ('confirmed', 'absent'));
alter table presences drop constraint if exists presences_guest_always_confirmed;
alter table presences add constraint presences_guest_always_confirmed
  check (player_id is not null or status = 'confirmed');

-- Posição na fila de espera dos avulsos (dentro de cada pelada) — atribuída
-- sozinha (fim da fila) quando a pessoa confirma presença, e só o admin pode
-- reordenar depois (setas ▲▼ na lista). É essa ordem, não mais o horário de
-- confirmação puro, que decide quem sobe pra CONFIRMADOS quando um
-- mensalista marca ausência.
alter table presences add column if not exists queue_order integer;

-- Mensalista que confirma depois de segunda 12h (o horário em que a lista
-- "abre" pra todo mundo) já pode ter perdido a vaga pra um avulso — essa
-- confirmação entra marcada como "late_rejoin", o app trata como se fosse
-- avulso (entra no fim da fila em vez de em CONFIRMADOS direto) até a
-- próxima pelada.
alter table presences add column if not exists late_rejoin boolean not null default false;

-- Preenche a posição de quem já estava confirmado antes dessa coluna
-- existir, na mesma ordem que já valia (por horário de confirmação), uma
-- fila por pelada.
with ranked as (
  select id, row_number() over (partition by pelada_id order by created_at asc) as rn
  from presences
  where status = 'confirmed' and queue_order is null
)
update presences set queue_order = ranked.rn
from ranked
where presences.id = ranked.id;

-- Só administrador pode reordenar a fila na mão; a posição em si continua
-- sendo atribuída sozinha (fim da fila daquela pelada) sempre que uma
-- presença vira/volta a ser 'confirmed', e some quando vira 'absent' (não
-- faz sentido guardar posição de fila pra quem não está esperando vaga).
create or replace function lock_presence_queue_order_field()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  next_order integer;
  needs_new_order boolean;
begin
  if tg_op = 'INSERT' then
    needs_new_order := (new.status = 'confirmed');
  else
    if not is_admin() then
      new.queue_order := old.queue_order;
    end if;
    needs_new_order := (
      new.status = 'confirmed'
      and (old.status is distinct from 'confirmed' or new.queue_order is null)
    );
  end if;

  if new.status <> 'confirmed' then
    new.queue_order := null;
  elsif needs_new_order then
    select coalesce(max(queue_order), 0) + 1 into next_order
    from presences
    where pelada_id = new.pelada_id
      and status = 'confirmed'
      and (tg_op = 'INSERT' or id <> new.id);
    new.queue_order := next_order;
  end if;

  return new;
end;
$$;

drop trigger if exists lock_presence_queue_order_trg on presences;
create trigger lock_presence_queue_order_trg
  before insert or update on presences
  for each row execute function lock_presence_queue_order_field();

-- Um jogador do elenco só pode ter UMA resposta por pelada (a mais recente
-- substitui a anterior via upsert). Constraint normal (não parcial) mesmo
-- assim funciona pros avulsos: o Postgres nunca considera dois NULLs iguais
-- pra fins de unicidade, então várias linhas de avulso (player_id null)
-- convivem sem problema. Precisa ser uma constraint "de verdade" (não só um
-- índice) pro upsert com onConflict do app conseguir mirar nela.
alter table presences drop constraint if exists presences_pelada_player_unique;
alter table presences add constraint presences_pelada_player_unique unique (pelada_id, player_id);

drop policy if exists "select_presences_public" on presences;
create policy "select_presences_public"
  on presences for select
  to anon, authenticated
  using (true);

-- Usuário comum só marca a PRÓPRIA presença/ausência; admin marca ou
-- remove qualquer jogador, e é o único que pode incluir avulso (guest_name).
drop policy if exists "insert_presences_self_or_admin" on presences;
create policy "insert_presences_self_or_admin"
  on presences for insert
  to authenticated
  with check (
    is_admin()
    or (guest_name is null and player_id in (select id from players where user_id = auth.uid()))
  );

drop policy if exists "update_presences_self_or_admin" on presences;
create policy "update_presences_self_or_admin"
  on presences for update
  to authenticated
  using (
    is_admin()
    or player_id in (select id from players where user_id = auth.uid())
  )
  with check (
    is_admin()
    or (guest_name is null and player_id in (select id from players where user_id = auth.uid()))
  );

drop policy if exists "delete_presences_self_or_admin" on presences;
create policy "delete_presences_self_or_admin"
  on presences for delete
  to authenticated
  using (
    is_admin()
    or player_id in (select id from players where user_id = auth.uid())
  );

-- Tempo real: a lista de presença atualiza sozinha na tela de quem estiver
-- olhando, à medida que outras pessoas forem confirmando/marcando ausência.
do $$
begin
  alter publication supabase_realtime add table presences;
exception
  when duplicate_object then null;
end $$;

-- Tempo real também pra "players": sem isso, quando um admin vincula o
-- login de alguém a um card (ou edita o card de alguém já logado), a pessoa
-- só via a mudança depois de recarregar a página manualmente.
do $$
begin
  alter publication supabase_realtime add table players;
exception
  when duplicate_object then null;
end $$;

-- ============================================================
-- Publicação e encerramento automático da lista semanal
-- ============================================================
-- Toda SEXTA-FEIRA 12h (horário de Brasília) publica a lista de presença
-- pra pelada de SEGUNDA-FEIRA seguinte, sempre na Arena PSG às 21h.
-- Toda TERÇA-FEIRA 0h (horário de Brasília) — logo depois da pelada de
-- segunda — a lista é encerrada — ela some da tela inicial, mas o registro
-- continua salvo por completo pro histórico dos administradores (nada é
-- apagado de verdade do banco).
--
-- Isso roda dentro do próprio Postgres do Supabase via pg_cron — não
-- depende de ninguém estar com o site aberto. O Supabase agenda tudo em
-- UTC, por isso os horários abaixo já estão convertidos
-- (Brasília = UTC-3, sem horário de verão):
--   sexta 12h BRT = sexta 15h UTC  → '0 15 * * 5'
--   terça 0h BRT  = terça 03h UTC  → '0 3 * * 2'
create extension if not exists pg_cron;

create or replace function publish_weekly_pelada()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  next_monday date;
begin
  -- Sexta = dow 5; (8 - 5) % 7 = 3 dias até a segunda seguinte.
  next_monday := current_date + ((8 - extract(dow from current_date)::int) % 7);
  update peladas set status = 'closed' where status = 'open';
  insert into peladas (scheduled_for, location, status)
  values (
    (next_monday + time '21:00') at time zone 'America/Sao_Paulo',
    'Arena PSG',
    'open'
  );
end;
$$;

create or replace function close_weekly_pelada()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update peladas set status = 'closed' where status = 'open';
end;
$$;

-- (Re)agenda os dois jobs — seguro rodar de novo (reagenda em cima do que
-- já existir, sem duplicar).
do $$
begin
  perform cron.unschedule('publish-weekly-pelada');
exception when others then null;
end $$;
select cron.schedule('publish-weekly-pelada', '0 15 * * 5', $$select publish_weekly_pelada();$$);

do $$
begin
  perform cron.unschedule('close-weekly-pelada');
exception when others then null;
end $$;
select cron.schedule('close-weekly-pelada', '0 3 * * 2', $$select close_weekly_pelada();$$);

-- ============================================================
-- Contato telefônico — visível SÓ pra administrador (ou o próprio dono)
-- ============================================================
-- Fica numa tabela separada de "players" de propósito: "players" é lido por
-- QUALQUER UM (até sem login), então um número de telefone nunca poderia
-- ficar de verdade restrito lá — RLS funciona por linha, não por coluna.
-- Aqui o SELECT já nasce travado a admin/dono.
create table if not exists player_contacts (
  player_id uuid primary key references players(id) on delete cascade,
  phone text,
  updated_at timestamptz not null default now()
);
alter table player_contacts enable row level security;

drop policy if exists "select_player_contacts_admin_or_self" on player_contacts;
create policy "select_player_contacts_admin_or_self"
  on player_contacts for select
  to authenticated
  using (is_admin() or player_id in (select id from players where user_id = auth.uid()));

drop policy if exists "insert_player_contacts_admin_or_self" on player_contacts;
create policy "insert_player_contacts_admin_or_self"
  on player_contacts for insert
  to authenticated
  with check (is_admin() or player_id in (select id from players where user_id = auth.uid()));

drop policy if exists "update_player_contacts_admin_or_self" on player_contacts;
create policy "update_player_contacts_admin_or_self"
  on player_contacts for update
  to authenticated
  using (is_admin() or player_id in (select id from players where user_id = auth.uid()))
  with check (is_admin() or player_id in (select id from players where user_id = auth.uid()));

drop policy if exists "delete_player_contacts_admin" on player_contacts;
create policy "delete_player_contacts_admin"
  on player_contacts for delete
  to authenticated
  using (is_admin());

-- ============================================================
-- Mensalistas x Avulsos
-- ============================================================
-- "membership_type" define o tipo de membro: 'mensalista' (paga mensalidade,
-- aprovado pelo admin, aparece no card com selo 🏅) ou 'avulso' (padrão —
-- aparece só como "Membro Avulso", confirma presença na aba AVULSOS, e vê o
-- aviso de pagamento avulso ao confirmar). "membership_interest_at" guarda
-- quando um avulso pediu pra virar mensalista (fila de aprovação do admin).
alter table players add column if not exists membership_type text not null default 'avulso';
alter table players drop constraint if exists players_membership_type_check;
alter table players add constraint players_membership_type_check
  check (membership_type in ('mensalista', 'avulso'));
alter table players add column if not exists membership_interest_at timestamptz;
-- Posição na fila de interessados em virar mensalista — atribuída sozinha
-- (fim da fila) assim que a pessoa pede, e só o admin pode reordenar
-- depois (arrastar pra cima/baixo na lista).
alter table players add column if not exists membership_interest_order integer;

-- Preenche a posição de quem já estava na fila antes dessa coluna existir,
-- na mesma ordem que já valia (por data do pedido).
with ranked as (
  select id, row_number() over (order by membership_interest_at asc) as rn
  from players
  where membership_interest_at is not null and membership_interest_order is null
)
update players set membership_interest_order = ranked.rn
from ranked
where players.id = ranked.id;

-- Só administrador pode transformar alguém em mensalista ou reordenar a
-- fila de interessados (o gatilho abaixo trava as colunas pra usuário
-- comum, mesmo tentando forçar via API) — exceto a posição na fila, que é
-- sempre calculada sozinha (fim da fila) no momento em que a própria
-- pessoa pede interesse pela primeira vez.
create or replace function lock_player_protected_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  next_order integer;
begin
  if not is_admin() then
    new.name := old.name;
    new.rating := old.rating;
    new.is_gk := old.is_gk;
    new.position := old.position;
    new.favorite_team := old.favorite_team;
    new.user_id := old.user_id;
    new.membership_type := old.membership_type;
    new.membership_interest_order := old.membership_interest_order;
  end if;

  -- Pedido novo de interesse (estava nulo, agora tem data) entra sozinho
  -- no fim da fila — ninguém escolhe a própria posição, nem admin nem a
  -- própria pessoa; só o reordenar manual (abaixo) muda isso depois.
  if new.membership_interest_at is not null and old.membership_interest_at is null then
    select coalesce(max(membership_interest_order), 0) + 1 into next_order from players;
    new.membership_interest_order := next_order;
  end if;
  if new.membership_interest_at is null then
    new.membership_interest_order := null;
  end if;

  return new;
end;
$$;

-- ============================================================
-- Avisos do admin — popup pra todo mundo (com ou sem login)
-- ============================================================
-- Um aviso "ativo" por vez (linha de id fixo — publicar substitui o
-- anterior, igual à lista sorteada). "mode" decide como ele se comporta:
-- 'once' aparece uma vez só (a pessoa fecha e nunca mais vê aquele aviso);
-- 'until_date' aparece de novo a cada visita até a data/hora de
-- "expires_at", mesmo que a pessoa já tenha fechado antes.
create table if not exists announcements (
  id uuid primary key,
  title text,
  message text not null,
  mode text not null default 'once' check (mode in ('once', 'until_date')),
  expires_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
alter table announcements enable row level security;

drop policy if exists "select_announcements_public" on announcements;
create policy "select_announcements_public"
  on announcements for select
  to anon, authenticated
  using (true);

drop policy if exists "write_announcements_admin" on announcements;
create policy "write_announcements_admin"
  on announcements for all
  to authenticated
  using (is_admin())
  with check (is_admin());

-- Tempo real: um aviso publicado aparece em popup sozinho, na hora, pra
-- quem já está com o app aberto — sem precisar recarregar a página.
do $$
begin
  alter publication supabase_realtime add table announcements;
exception
  when duplicate_object then null;
end $$;

-- ============================================================
-- Controle financeiro — caixa por admin (recebimentos + saídas)
-- ============================================================

-- Guarda quem marcou o pagamento avulso como pago (e quando) — mesma ideia
-- do "updated_by"/"paid_at" que já existe em membership_payments, pra dar
-- pra atribuir o recebimento ao caixa do admin certo.
alter table presences add column if not exists paid_by uuid references auth.users(id);
alter table presences add column if not exists paid_at timestamptz;

create or replace function lock_presence_paid_field()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_admin() then
    if tg_op = 'INSERT' then
      new.paid := false;
      new.paid_by := null;
      new.paid_at := null;
    else
      new.paid := old.paid;
      new.paid_by := old.paid_by;
      new.paid_at := old.paid_at;
    end if;
  end if;
  return new;
end;
$$;

-- Saídas do caixa (gastos) — cada linha pertence ao caixa do admin que
-- registrou ("admin_id"). Os recebimentos não têm tabela própria: são lidos
-- direto de membership_payments (updated_by) e presences (paid_by).
create table if not exists cash_expenses (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references auth.users(id),
  description text not null,
  amount numeric(10,2) not null check (amount > 0),
  created_at timestamptz not null default now()
);
alter table cash_expenses enable row level security;

drop policy if exists "select_cash_expenses_admin" on cash_expenses;
create policy "select_cash_expenses_admin"
  on cash_expenses for select
  to authenticated
  using (is_admin());

drop policy if exists "write_cash_expenses_admin" on cash_expenses;
create policy "write_cash_expenses_admin"
  on cash_expenses for all
  to authenticated
  using (is_admin())
  with check (is_admin());
