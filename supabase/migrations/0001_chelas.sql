-- Millón de Chelas: conteo colectivo con foto.
-- El cliente nunca escribe directo en las tablas: todo pasa por registrar_chela / borrar_chela,
-- que validan, calculan cuántas chelas vale la foto y mueven el marcador en la misma transacción.

create extension if not exists pgcrypto with schema extensions;

-- Ajustes privados (la clave de admin). Fuera del API: el esquema private no se expone.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table private.ajustes (
  id int primary key default 1 check (id = 1),
  clave_admin text not null
);

-- Marcador global: una sola fila. total arranca en el conteo que ya llevaba el grupo de WhatsApp.
create table public.marcador (
  id int primary key default 1 check (id = 1),
  total int not null check (total >= 0),
  meta int not null default 1000000,
  actualizado timestamptz not null default now()
);
insert into public.marcador (total) values (9121);

-- Cada foto registrada. numero = el conteo colectivo con el que quedó (la última chela de la foto).
create table public.chelas (
  id bigint generated always as identity primary key,
  creado timestamptz not null default now(),
  nombre text not null check (char_length(nombre) between 1 and 30),
  tipo text not null check (char_length(tipo) between 1 and 40),
  ml int not null check (ml between 250 and 5000),
  cantidad int not null default 1 check (cantidad between 1 and 24),
  cuenta int not null check (cuenta between 1 and 400),
  numero int not null,
  foto text not null unique,
  -- sha256 (hex) del secreto del dispositivo: el cliente reconoce sus fotos sin exponer el secreto.
  autor text not null
);
create index chelas_creado_idx on public.chelas (creado desc);
create index chelas_nombre_idx on public.chelas (lower(nombre));
create index chelas_autor_idx on public.chelas (autor, creado desc);

alter table public.marcador enable row level security;
alter table public.chelas enable row level security;
create policy "todos leen el marcador" on public.marcador for select to anon, authenticated using (true);
create policy "todos ven las chelas" on public.chelas for select to anon, authenticated using (true);

revoke insert, update, delete, truncate on public.marcador, public.chelas from anon, authenticated;
grant select on public.marcador, public.chelas to anon, authenticated;

-- Reglas del grupo: <250 ml no cuenta, 250-599 ml = 1, desde 600 ml sube 1 cada 300 ml
-- (600 = 2, 900 = 3, 1200 = 4). Si cambian las reglas, cambiar aquí y en src/reglas.ts.
create or replace function public.chelas_por_ml(p_ml int)
returns int
language sql immutable
set search_path = ''
as $$
  select case when p_ml is null or p_ml < 250 then 0 when p_ml < 600 then 1 else p_ml / 300 end
$$;

create or replace function public.registrar_chela(
  p_nombre text, p_tipo text, p_ml int, p_cantidad int, p_foto text, p_secreto text
)
returns public.chelas
language plpgsql security definer
set search_path = ''
as $$
declare
  v_nombre text := btrim(regexp_replace(coalesce(p_nombre, ''), '\s+', ' ', 'g'));
  v_tipo text := btrim(coalesce(p_tipo, ''));
  v_autor text;
  v_cuenta int;
  v_total int;
  v_fila public.chelas;
begin
  if char_length(v_nombre) not between 1 and 30 then raise exception 'nombre_invalido'; end if;
  if char_length(v_tipo) not between 1 and 40 then raise exception 'tipo_invalido'; end if;
  if p_ml is null or p_ml < 250 then raise exception 'no_cuenta'; end if;
  if p_ml > 5000 then raise exception 'ml_invalido'; end if;
  if p_cantidad is null or p_cantidad not between 1 and 24 then raise exception 'cantidad_invalida'; end if;
  if p_secreto is null or char_length(p_secreto) < 20 then raise exception 'secreto_invalido'; end if;
  if p_foto is null or p_foto !~ '^[0-9]{4}-[0-9]{2}/[0-9a-f-]{36}\.jpg$' then raise exception 'foto_invalida'; end if;
  if not exists (select 1 from storage.objects where bucket_id = 'fotos' and name = p_foto) then
    raise exception 'foto_no_subida';
  end if;

  v_autor := encode(extensions.digest(p_secreto, 'sha256'), 'hex');
  -- Freno anti-dedo-nervioso: máximo 6 fotos por minuto por dispositivo.
  if (select count(*) from public.chelas where autor = v_autor and creado > now() - interval '1 minute') >= 6 then
    raise exception 'muy_rapido';
  end if;

  v_cuenta := public.chelas_por_ml(p_ml) * p_cantidad;

  -- La fila del marcador serializa los registros simultáneos: cada foto recibe su número exacto.
  update public.marcador set total = total + v_cuenta, actualizado = now() where id = 1
  returning total into v_total;

  insert into public.chelas (nombre, tipo, ml, cantidad, cuenta, numero, foto, autor)
  values (v_nombre, v_tipo, p_ml, p_cantidad, v_cuenta, v_total, p_foto, v_autor)
  returning * into v_fila;
  return v_fila;
end
$$;

-- Borra una foto propia (secreto del dispositivo) o cualquiera con la clave de admin; resta su cuenta.
create or replace function public.borrar_chela(p_id bigint, p_secreto text)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_admin boolean;
  v_fila public.chelas;
begin
  select coalesce(p_secreto = clave_admin, false) into v_admin from private.ajustes where id = 1;
  delete from public.chelas
   where id = p_id
     and (coalesce(v_admin, false) or autor = encode(extensions.digest(coalesce(p_secreto, ''), 'sha256'), 'hex'))
  returning * into v_fila;
  if v_fila.id is null then return false; end if;
  update public.marcador set total = greatest(total - v_fila.cuenta, 0), actualizado = now() where id = 1;
  return true;
end
$$;

create or replace function public.es_admin(p_clave text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce((select p_clave = clave_admin from private.ajustes where id = 1), false)
$$;

-- Para empatar el marcador con el conteo de WhatsApp (solo admin).
create or replace function public.ajustar_total(p_clave text, p_total int)
returns int
language plpgsql security definer
set search_path = ''
as $$
declare v_total int;
begin
  if not public.es_admin(p_clave) then raise exception 'no_autorizado'; end if;
  if p_total is null or p_total < 0 then raise exception 'total_invalido'; end if;
  update public.marcador set total = p_total, actualizado = now() where id = 1 returning total into v_total;
  return v_total;
end
$$;

-- Ranking por nombre (sin distinguir mayúsculas). p_desde null = de siempre.
create or replace function public.ranking(p_desde timestamptz default null)
returns table (nombre text, chelas bigint, fotos bigint)
language sql stable
set search_path = ''
as $$
  select (array_agg(c.nombre order by c.id desc))[1], sum(c.cuenta), count(*)
  from public.chelas c
  where p_desde is null or c.creado >= p_desde
  group by lower(c.nombre)
  order by 2 desc, 3 desc
  limit 50
$$;

revoke execute on function public.registrar_chela(text, text, int, int, text, text) from public;
revoke execute on function public.borrar_chela(bigint, text) from public;
revoke execute on function public.es_admin(text) from public;
revoke execute on function public.ajustar_total(text, int) from public;
grant execute on function public.chelas_por_ml(int) to anon, authenticated;
grant execute on function public.registrar_chela(text, text, int, int, text, text) to anon, authenticated;
grant execute on function public.borrar_chela(bigint, text) to anon, authenticated;
grant execute on function public.es_admin(text) to anon, authenticated;
grant execute on function public.ajustar_total(text, int) to anon, authenticated;
grant execute on function public.ranking(timestamptz) to anon, authenticated;

-- Tiempo real: nuevas fotos, borradas y el marcador.
alter publication supabase_realtime add table public.chelas, public.marcador;

-- Fotos: bucket público (se leen por URL), solo JPEG de hasta 3 MB, rutas con forma fija.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fotos', 'fotos', true, 3145728, array['image/jpeg']);

create policy "subir fotos de chelas" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'fotos' and name ~ '^[0-9]{4}-[0-9]{2}/[0-9a-f-]{36}\.jpg$');
