-- 0002: cada foto pasa por revisión antes de contar.
--   1. El cliente registra la foto: queda 'pendiente' y todavía no tiene número ni suma.
--   2. El Worker (worker/) la revisa: un modelo con visión (OpenRouter) la describe y Jev decide
--      si es cerveza. Aprobada → recibe número y suma al marcador; dudosa → 'revision' (admin);
--      no es cerveza → 'rechazada' (el admin puede corregir).
--   3. Panel de admin (/admin) con PIN: autorizar o denegar cualquier foto.
-- El Worker se autentica con private.ajustes.clave_servidor; el admin, con pin_admin.

-- ───────── ajustes y validación

alter table private.ajustes rename column clave_admin to pin_admin;
alter table private.ajustes add column clave_servidor text;

-- Fallos de PIN: con 15 en 10 minutos el panel se bloquea (para todos) hasta que bajen.
create table private.intentos_admin (creado timestamptz not null default now());
create index intentos_admin_creado_idx on private.intentos_admin (creado);

-- Valida el PIN y registra el fallo. Quien la llame NO debe lanzar excepción después de un
-- fallo (revertiría el registro): las funciones de admin regresan null / vacío.
create or replace function private.pin_valido(p_pin text)
returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
declare v_ok boolean;
begin
  if (select count(*) from private.intentos_admin where creado > now() - interval '10 minutes') >= 15 then
    raise exception 'bloqueado';
  end if;
  select coalesce(p_pin = pin_admin, false) into v_ok from private.ajustes where id = 1;
  if coalesce(v_ok, false) then return true; end if;
  insert into private.intentos_admin default values;
  delete from private.intentos_admin where creado < now() - interval '1 day';
  return false;
end
$$;

create or replace function private.servidor_valido(p_clave text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce((select p_clave is not null and p_clave = clave_servidor from private.ajustes where id = 1), false)
$$;

-- ───────── chelas: estado de revisión

alter table public.chelas
  alter column numero drop not null,
  add column estado text not null default 'pendiente'
    check (estado in ('pendiente', 'revision', 'aprobada', 'rechazada')),
  -- Orden de aprobación (el feed va por aquí): el número puede repetirse si un admin deniega
  -- una ya aprobada y el marcador baja.
  add column orden bigint unique,
  add column mini text,
  -- Lo que vio la IA: {es_cerveza, marca, estilo, abv, origen, descripcion, dato, cantidad_visible, ...}
  add column ia jsonb,
  -- Probabilidad (Jev) de que sea una cerveza válida.
  add column jev real,
  add column motivo text,
  add column ia_intentos int not null default 0,
  add column ia_tomado timestamptz,
  add column decidido timestamptz,
  add column decidio text check (decidio in ('ia', 'admin'));

create sequence public.chelas_orden_seq owned by public.chelas.orden;
create index chelas_estado_idx on public.chelas (estado, id desc);

-- El público solo ve las aprobadas (feed, tiempo real y ranking).
drop policy "todos ven las chelas" on public.chelas;
create policy "todos ven las chelas aprobadas" on public.chelas
  for select to anon, authenticated using (estado = 'aprobada');

-- Miniatura (lado mayor 640 px) junto a la foto: mismo uuid con -mini.
drop policy "subir fotos de chelas" on storage.objects;
create policy "subir fotos de chelas" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'fotos' and name ~ '^[0-9]{4}-[0-9]{2}/[0-9a-f-]{36}(-mini)?\.jpg$');

-- ───────── transiciones (internas)

-- Aprobar: número = marcador + cuenta. Idempotente.
create or replace function private.aprobar(p_id bigint, p_quien text)
returns public.chelas
language plpgsql security definer
set search_path = ''
as $$
declare
  v_fila public.chelas;
  v_total int;
begin
  select * into v_fila from public.chelas where id = p_id for update;
  if v_fila.id is null or v_fila.estado = 'aprobada' then return v_fila; end if;
  update public.marcador set total = total + v_fila.cuenta, actualizado = now() where id = 1
  returning total into v_total;
  update public.chelas
     set estado = 'aprobada', numero = v_total, orden = nextval('public.chelas_orden_seq'),
         decidido = now(), decidio = p_quien
   where id = p_id
  returning * into v_fila;
  return v_fila;
end
$$;

-- Rechazar: si ya contaba, se resta del marcador.
create or replace function private.rechazar(p_id bigint, p_quien text, p_motivo text)
returns public.chelas
language plpgsql security definer
set search_path = ''
as $$
declare v_fila public.chelas;
begin
  select * into v_fila from public.chelas where id = p_id for update;
  if v_fila.id is null or v_fila.estado = 'rechazada' then return v_fila; end if;
  if v_fila.estado = 'aprobada' then
    update public.marcador set total = greatest(total - v_fila.cuenta, 0), actualizado = now() where id = 1;
  end if;
  update public.chelas
     set estado = 'rechazada', orden = null, decidido = now(), decidio = p_quien,
         motivo = coalesce(p_motivo, motivo)
   where id = p_id
  returning * into v_fila;
  return v_fila;
end
$$;

-- ───────── cliente

drop function public.registrar_chela(text, text, int, int, text, text);

create or replace function public.registrar_chela(
  p_nombre text, p_tipo text, p_ml int, p_cantidad int, p_foto text, p_mini text, p_secreto text
)
returns public.chelas
language plpgsql security definer
set search_path = ''
as $$
declare
  v_nombre text := btrim(regexp_replace(coalesce(p_nombre, ''), '\s+', ' ', 'g'));
  v_tipo text := btrim(coalesce(p_tipo, ''));
  v_autor text;
  v_fila public.chelas;
begin
  if char_length(v_nombre) not between 1 and 30 then raise exception 'nombre_invalido'; end if;
  if char_length(v_tipo) not between 1 and 40 then raise exception 'tipo_invalido'; end if;
  if p_ml is null or p_ml < 250 then raise exception 'no_cuenta'; end if;
  if p_ml > 5000 then raise exception 'ml_invalido'; end if;
  if p_cantidad is null or p_cantidad not between 1 and 24 then raise exception 'cantidad_invalida'; end if;
  if p_secreto is null or char_length(p_secreto) < 20 then raise exception 'secreto_invalido'; end if;
  if p_foto is null or p_foto !~ '^[0-9]{4}-[0-9]{2}/[0-9a-f-]{36}\.jpg$' then raise exception 'foto_invalida'; end if;
  if p_mini is not null and p_mini <> regexp_replace(p_foto, '\.jpg$', '-mini.jpg') then raise exception 'foto_invalida'; end if;
  if not exists (select 1 from storage.objects where bucket_id = 'fotos' and name = p_foto) then
    raise exception 'foto_no_subida';
  end if;
  if p_mini is not null and not exists (select 1 from storage.objects where bucket_id = 'fotos' and name = p_mini) then
    raise exception 'foto_no_subida';
  end if;

  v_autor := encode(extensions.digest(p_secreto, 'sha256'), 'hex');
  if (select count(*) from public.chelas where autor = v_autor and creado > now() - interval '1 minute') >= 6 then
    raise exception 'muy_rapido';
  end if;

  insert into public.chelas (nombre, tipo, ml, cantidad, cuenta, foto, mini, autor)
  values (v_nombre, v_tipo, p_ml, p_cantidad, public.chelas_por_ml(p_ml) * p_cantidad, p_foto, p_mini, v_autor)
  returning * into v_fila;
  return v_fila;
end
$$;

-- Estado de mis fotos recientes que aún no salen en el feed (en revisión o rechazadas).
create or replace function public.mis_revisiones(p_secreto text)
returns setof public.chelas
language sql stable security definer
set search_path = ''
as $$
  select * from public.chelas
   where autor = encode(extensions.digest(coalesce(p_secreto, ''), 'sha256'), 'hex')
     and estado <> 'aprobada' and creado > now() - interval '3 days'
   order by id desc
   limit 20
$$;

-- El autor borra su foto; si contaba, se resta.
create or replace function public.borrar_chela(p_id bigint, p_secreto text)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare v_fila public.chelas;
begin
  delete from public.chelas
   where id = p_id and autor = encode(extensions.digest(coalesce(p_secreto, ''), 'sha256'), 'hex')
  returning * into v_fila;
  if v_fila.id is null then return false; end if;
  if v_fila.estado = 'aprobada' then
    update public.marcador set total = greatest(total - v_fila.cuenta, 0), actualizado = now() where id = 1;
  end if;
  return true;
end
$$;

drop function public.es_admin(text);
drop function public.ajustar_total(text, int);

drop function public.ranking(timestamptz);
create or replace function public.ranking(p_desde timestamptz default null)
returns table (nombre text, chelas bigint, fotos bigint)
language sql stable
set search_path = ''
as $$
  select (array_agg(c.nombre order by c.id desc))[1], sum(c.cuenta), count(*)
  from public.chelas c
  where c.estado = 'aprobada' and (p_desde is null or c.decidido >= p_desde)
  group by lower(c.nombre)
  order by 2 desc, 3 desc
  limit 50
$$;

-- Clasificación por marca (lo que identificó la IA).
create or replace function public.ranking_marcas(p_desde timestamptz default null)
returns table (marca text, estilo text, chelas bigint, fotos bigint)
language sql stable
set search_path = ''
as $$
  select (array_agg(m.marca order by m.id desc))[1],
         (array_agg(m.estilo order by m.id desc) filter (where m.estilo is not null))[1],
         sum(m.cuenta), count(*)
  from (
    select c.id, c.cuenta, coalesce(nullif(btrim(c.ia->>'marca'), ''), 'Sin identificar') as marca,
           nullif(btrim(c.ia->>'estilo'), '') as estilo
    from public.chelas c
    where c.estado = 'aprobada' and (p_desde is null or c.decidido >= p_desde)
  ) m
  group by lower(m.marca)
  order by 3 desc, 4 desc
  limit 50
$$;

-- ───────── servidor (Worker con clave_servidor)

-- Toma una pendiente para revisarla: a lo más 3 intentos, uno cada 90 s. null = no le toca.
create or replace function public.ia_tomar(p_clave text, p_id bigint)
returns public.chelas
language plpgsql security definer
set search_path = ''
as $$
declare v_fila public.chelas;
begin
  if not private.servidor_valido(p_clave) then raise exception 'no_autorizado'; end if;
  update public.chelas
     set ia_intentos = ia_intentos + 1, ia_tomado = now()
   where id = p_id and estado = 'pendiente' and ia_intentos < 3
     and (ia_tomado is null or ia_tomado < now() - interval '90 seconds')
  returning * into v_fila;
  return v_fila;
end
$$;

-- Resultado de la revisión. Si un admin ya decidió mientras tanto, no se toca.
create or replace function public.ia_resolver(
  p_clave text, p_id bigint, p_decision text, p_ia jsonb, p_jev real, p_motivo text
)
returns public.chelas
language plpgsql security definer
set search_path = ''
as $$
declare v_fila public.chelas;
begin
  if not private.servidor_valido(p_clave) then raise exception 'no_autorizado'; end if;
  if p_decision not in ('aprobada', 'rechazada', 'revision') then raise exception 'decision_invalida'; end if;
  update public.chelas set ia = coalesce(p_ia, ia), jev = p_jev, motivo = p_motivo
   where id = p_id and estado = 'pendiente';
  if not found then
    select * into v_fila from public.chelas where id = p_id;
    return v_fila;
  end if;
  if p_decision = 'aprobada' then return private.aprobar(p_id, 'ia'); end if;
  if p_decision = 'rechazada' then return private.rechazar(p_id, 'ia', p_motivo); end if;
  update public.chelas set estado = 'revision' where id = p_id returning * into v_fila;
  return v_fila;
end
$$;

-- Para el cron: pendientes que nadie revisó (o cuyo intento falló). Las que agotaron sus 3
-- intentos pasan a revisión del admin.
create or replace function public.ia_pendientes(p_clave text)
returns setof bigint
language plpgsql security definer
set search_path = ''
as $$
begin
  if not private.servidor_valido(p_clave) then raise exception 'no_autorizado'; end if;
  update public.chelas
     set estado = 'revision', motivo = coalesce(motivo, 'La IA no pudo revisarla')
   where estado = 'pendiente' and ia_intentos >= 3 and ia_tomado < now() - interval '90 seconds';
  return query
    select id from public.chelas
     where estado = 'pendiente' and ia_intentos < 3
       and ((ia_tomado is null and creado < now() - interval '30 seconds')
            or ia_tomado < now() - interval '90 seconds')
     order by id
     limit 10;
end
$$;

-- ───────── admin (PIN)

create or replace function public.admin_entrar(p_pin text)
returns boolean
language sql volatile security definer
set search_path = ''
as $$
  select private.pin_valido(p_pin)
$$;

create or replace function public.admin_conteos(p_pin text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if not private.pin_valido(p_pin) then return null; end if;
  return coalesce((select jsonb_object_agg(estado, n) from (select estado, count(*) n from public.chelas group by estado) t), '{}'::jsonb);
end
$$;

create or replace function public.admin_listar(p_pin text, p_estados text[], p_antes bigint default null, p_limite int default 30)
returns setof public.chelas
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if not private.pin_valido(p_pin) then return; end if;
  return query
    select * from public.chelas c
     where c.estado = any (p_estados) and (p_antes is null or c.id < p_antes)
     order by c.id desc
     limit least(greatest(coalesce(p_limite, 30), 1), 100);
end
$$;

create or replace function public.admin_decidir(p_pin text, p_id bigint, p_decision text, p_motivo text default null)
returns public.chelas
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if not private.pin_valido(p_pin) then return null; end if;
  if p_decision = 'aprobada' then return private.aprobar(p_id, 'admin'); end if;
  if p_decision = 'rechazada' then
    return private.rechazar(p_id, 'admin', coalesce(nullif(btrim(p_motivo), ''), 'Rechazada por un admin'));
  end if;
  raise exception 'decision_invalida';
end
$$;

create or replace function public.admin_ajustar_total(p_pin text, p_total int)
returns int
language plpgsql volatile security definer
set search_path = ''
as $$
declare v_total int;
begin
  if not private.pin_valido(p_pin) then return null; end if;
  if p_total is null or p_total < 0 then raise exception 'total_invalido'; end if;
  update public.marcador set total = p_total, actualizado = now() where id = 1 returning total into v_total;
  return v_total;
end
$$;

-- ───────── permisos

revoke execute on all functions in schema private from public, anon, authenticated;

do $$
declare f text;
begin
  foreach f in array array[
    'public.registrar_chela(text, text, int, int, text, text, text)',
    'public.mis_revisiones(text)',
    'public.borrar_chela(bigint, text)',
    'public.ranking(timestamptz)',
    'public.ranking_marcas(timestamptz)',
    'public.ia_tomar(text, bigint)',
    'public.ia_resolver(text, bigint, text, jsonb, real, text)',
    'public.ia_pendientes(text)',
    'public.admin_entrar(text)',
    'public.admin_conteos(text)',
    'public.admin_listar(text, text[], bigint, int)',
    'public.admin_decidir(text, bigint, text, text)',
    'public.admin_ajustar_total(text, int)'
  ] loop
    execute format('revoke execute on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end
$$;
