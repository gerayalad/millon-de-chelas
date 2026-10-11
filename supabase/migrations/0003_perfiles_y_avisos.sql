-- 0003: perfil (nombre + teléfono opcional + consentimiento de promos) y avisos push de metas.
-- Todo en el esquema private: nada de esto se lee desde la app pública; solo por funciones.

-- ───────── perfiles (uno por dispositivo: autor = sha256 del secreto del dispositivo)

create table private.perfiles (
  autor text primary key,
  nombre text not null check (char_length(nombre) between 1 and 30),
  -- E.164 (+52XXXXXXXXXX). Opcional.
  telefono text check (telefono ~ '^\+[1-9][0-9]{7,14}$'),
  -- Consentimiento aparte (casilla sin marcar) para promos y para compartir con marcas aliadas.
  acepta_promos boolean not null default false,
  acepta_promos_en timestamptz,
  -- Versión del aviso de privacidad que vio al guardar.
  aviso text not null,
  creado timestamptz not null default now(),
  actualizado timestamptz not null default now()
);

-- Teléfono: 10 dígitos = México (+52); con + y código de país, internacional. null si viene vacío.
create or replace function private.normalizar_telefono(p text)
returns text
language plpgsql immutable
set search_path = ''
as $$
declare d text := regexp_replace(coalesce(p, ''), '[^0-9+]', '', 'g');
begin
  if d = '' then return null; end if;
  if d ~ '^[0-9]{10}$' then return '+52' || d; end if;
  if d ~ '^52[0-9]{10}$' then return '+' || d; end if;
  if d ~ '^\+[1-9][0-9]{7,14}$' then return d; end if;
  raise exception 'telefono_invalido';
end
$$;

create or replace function public.guardar_perfil(
  p_secreto text, p_nombre text, p_telefono text, p_acepta_promos boolean, p_aviso text
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_autor text;
  v_nombre text := btrim(regexp_replace(coalesce(p_nombre, ''), '\s+', ' ', 'g'));
  v_tel text := private.normalizar_telefono(p_telefono);
  v_p private.perfiles;
begin
  if p_secreto is null or char_length(p_secreto) < 20 then raise exception 'secreto_invalido'; end if;
  if char_length(v_nombre) not between 1 and 30 then raise exception 'nombre_invalido'; end if;
  if coalesce(btrim(p_aviso), '') = '' then raise exception 'aviso_invalido'; end if;
  v_autor := encode(extensions.digest(p_secreto, 'sha256'), 'hex');
  insert into private.perfiles as p (autor, nombre, telefono, acepta_promos, acepta_promos_en, aviso)
  values (v_autor, v_nombre, v_tel, coalesce(p_acepta_promos, false),
          case when p_acepta_promos then now() end, p_aviso)
  on conflict (autor) do update
     set nombre = excluded.nombre,
         telefono = excluded.telefono,
         acepta_promos = excluded.acepta_promos,
         -- La fecha del consentimiento se conserva mientras siga aceptando.
         acepta_promos_en = case when excluded.acepta_promos then coalesce(p.acepta_promos_en, now()) end,
         aviso = excluded.aviso,
         actualizado = now()
  returning * into v_p;
  return jsonb_build_object('nombre', v_p.nombre, 'telefono', v_p.telefono, 'acepta_promos', v_p.acepta_promos);
end
$$;

create or replace function public.mi_perfil(p_secreto text)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object('nombre', p.nombre, 'telefono', p.telefono, 'acepta_promos', p.acepta_promos)
    from private.perfiles p
   where p.autor = encode(extensions.digest(coalesce(p_secreto, ''), 'sha256'), 'hex')
$$;

-- Derecho de cancelación desde la app: borra el perfil (nombre, teléfono y consentimiento).
create or replace function public.borrar_perfil(p_secreto text)
returns boolean
language sql volatile security definer
set search_path = ''
as $$
  with b as (
    delete from private.perfiles
     where autor = encode(extensions.digest(coalesce(p_secreto, ''), 'sha256'), 'hex')
    returning 1
  )
  select exists (select 1 from b)
$$;

-- ───────── avisos push de metas

create table private.suscripciones (
  endpoint text primary key check (endpoint ~ '^https://'),
  p256dh text not null,
  auth text not null,
  autor text,
  creado timestamptz not null default now()
);

-- Última meta avisada (múltiplo de 1,000). Arranca en la del conteo actual: no avisa lo ya pasado.
alter table private.ajustes add column ultimo_hito int not null default 0;
update private.ajustes set ultimo_hito = (select (total / 1000) * 1000 from public.marcador where id = 1) where id = 1;

create or replace function public.guardar_suscripcion(p_secreto text, p_endpoint text, p_p256dh text, p_auth text)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
begin
  if p_endpoint is null or p_endpoint !~ '^https://' or char_length(p_endpoint) > 1000 then raise exception 'suscripcion_invalida'; end if;
  if coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then raise exception 'suscripcion_invalida'; end if;
  insert into private.suscripciones (endpoint, p256dh, auth, autor)
  values (p_endpoint, p_p256dh, p_auth, encode(extensions.digest(coalesce(p_secreto, ''), 'sha256'), 'hex'))
  on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, autor = excluded.autor;
  return true;
end
$$;

create or replace function public.borrar_suscripcion(p_endpoint text)
returns boolean
language sql volatile security definer
set search_path = ''
as $$
  with b as (delete from private.suscripciones where endpoint = p_endpoint returning 1)
  select exists (select 1 from b)
$$;

-- Cron del Worker: si el marcador cruzó un nuevo millar, lo marca como avisado y regresa a
-- quién avisar. Si no, regresa null. (Si el conteo baja, no se vuelve a avisar el mismo millar.)
create or replace function public.push_hito(p_clave text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_total int;
  v_hito int;
begin
  if not private.servidor_valido(p_clave) then raise exception 'no_autorizado'; end if;
  select total into v_total from public.marcador where id = 1;
  v_hito := (v_total / 1000) * 1000;
  update private.ajustes set ultimo_hito = v_hito where id = 1 and ultimo_hito < v_hito;
  if not found then return null; end if;
  return jsonb_build_object(
    'hito', v_hito,
    'total', v_total,
    'endpoints', coalesce((select jsonb_agg(endpoint) from private.suscripciones), '[]'::jsonb)
  );
end
$$;

-- Suscripciones que el servicio de push dio por muertas (404/410).
create or replace function public.push_bajas(p_clave text, p_endpoints text[])
returns int
language plpgsql security definer
set search_path = ''
as $$
declare n int;
begin
  if not private.servidor_valido(p_clave) then raise exception 'no_autorizado'; end if;
  delete from private.suscripciones where endpoint = any (p_endpoints);
  get diagnostics n = row_count;
  return n;
end
$$;

revoke execute on all functions in schema private from public, anon, authenticated;

do $$
declare f text;
begin
  foreach f in array array[
    'public.guardar_perfil(text, text, text, boolean, text)',
    'public.mi_perfil(text)',
    'public.borrar_perfil(text)',
    'public.guardar_suscripcion(text, text, text, text)',
    'public.borrar_suscripcion(text)',
    'public.push_hito(text)',
    'public.push_bajas(text, text[])'
  ] loop
    execute format('revoke execute on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end
$$;
