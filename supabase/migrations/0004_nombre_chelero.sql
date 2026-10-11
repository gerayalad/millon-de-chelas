-- 0004: el nombre del perfil es un "nombre chelero" único, tipo username.
--   · 3-20 caracteres: letras (con acentos y ñ), números, _ y . — sin espacios.
--   · Único sin distinguir mayúsculas. Lo "aparta" el dispositivo que lo creó (autor).
--   · Las fotos se registran siempre con el nombre chelero del perfil (nadie sube a nombre de otro);
--     si se cambia, se renombran sus fotos para no partir el ranking.

alter table private.perfiles
  add constraint perfiles_nombre_chelero check (nombre ~ '^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9_.]{3,20}$');
create unique index perfiles_nombre_unico on private.perfiles (lower(nombre));

create or replace function public.nombre_disponible(p_nombre text, p_secreto text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select btrim(coalesce(p_nombre, '')) ~ '^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9_.]{3,20}$'
     and not exists (
       select 1 from private.perfiles
        where lower(nombre) = lower(btrim(p_nombre))
          and autor <> encode(extensions.digest(coalesce(p_secreto, ''), 'sha256'), 'hex')
     )
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
  v_nombre text := btrim(coalesce(p_nombre, ''));
  v_tel text := private.normalizar_telefono(p_telefono);
  v_anterior text;
  v_p private.perfiles;
begin
  if p_secreto is null or char_length(p_secreto) < 20 then raise exception 'secreto_invalido'; end if;
  if v_nombre !~ '^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9_.]{3,20}$' then raise exception 'nombre_invalido'; end if;
  if coalesce(btrim(p_aviso), '') = '' then raise exception 'aviso_invalido'; end if;
  v_autor := encode(extensions.digest(p_secreto, 'sha256'), 'hex');
  if exists (select 1 from private.perfiles where lower(nombre) = lower(v_nombre) and autor <> v_autor) then
    raise exception 'nombre_tomado';
  end if;
  select nombre into v_anterior from private.perfiles where autor = v_autor;

  insert into private.perfiles as p (autor, nombre, telefono, acepta_promos, acepta_promos_en, aviso)
  values (v_autor, v_nombre, v_tel, coalesce(p_acepta_promos, false),
          case when p_acepta_promos then now() end, p_aviso)
  on conflict (autor) do update
     set nombre = excluded.nombre,
         telefono = excluded.telefono,
         acepta_promos = excluded.acepta_promos,
         acepta_promos_en = case when excluded.acepta_promos then coalesce(p.acepta_promos_en, now()) end,
         aviso = excluded.aviso,
         actualizado = now()
  returning * into v_p;

  -- Renombrar sus fotos (el ranking agrupa por nombre).
  if v_anterior is distinct from v_nombre then
    update public.chelas set nombre = v_nombre where autor = v_autor;
  end if;
  return jsonb_build_object('nombre', v_p.nombre, 'telefono', v_p.telefono, 'acepta_promos', v_p.acepta_promos);
exception
  when unique_violation then raise exception 'nombre_tomado';
end
$$;

-- registrar_chela: el nombre sale del perfil del dispositivo (p_nombre se ignora; se deja en la
-- firma para no romper clientes). Sin perfil no se puede registrar.
create or replace function public.registrar_chela(
  p_nombre text, p_tipo text, p_ml int, p_cantidad int, p_foto text, p_mini text, p_secreto text
)
returns public.chelas
language plpgsql security definer
set search_path = ''
as $$
declare
  v_nombre text;
  v_tipo text := btrim(coalesce(p_tipo, ''));
  v_autor text;
  v_fila public.chelas;
begin
  if p_secreto is null or char_length(p_secreto) < 20 then raise exception 'secreto_invalido'; end if;
  v_autor := encode(extensions.digest(p_secreto, 'sha256'), 'hex');
  select nombre into v_nombre from private.perfiles where autor = v_autor;
  if v_nombre is null then raise exception 'sin_perfil'; end if;
  if char_length(v_tipo) not between 1 and 40 then raise exception 'tipo_invalido'; end if;
  if p_ml is null or p_ml < 250 then raise exception 'no_cuenta'; end if;
  if p_ml > 5000 then raise exception 'ml_invalido'; end if;
  if p_cantidad is null or p_cantidad not between 1 and 24 then raise exception 'cantidad_invalida'; end if;
  if p_foto is null or p_foto !~ '^[0-9]{4}-[0-9]{2}/[0-9a-f-]{36}\.jpg$' then raise exception 'foto_invalida'; end if;
  if p_mini is not null and p_mini <> regexp_replace(p_foto, '\.jpg$', '-mini.jpg') then raise exception 'foto_invalida'; end if;
  if not exists (select 1 from storage.objects where bucket_id = 'fotos' and name = p_foto) then
    raise exception 'foto_no_subida';
  end if;
  if p_mini is not null and not exists (select 1 from storage.objects where bucket_id = 'fotos' and name = p_mini) then
    raise exception 'foto_no_subida';
  end if;
  if (select count(*) from public.chelas where autor = v_autor and creado > now() - interval '1 minute') >= 6 then
    raise exception 'muy_rapido';
  end if;

  insert into public.chelas (nombre, tipo, ml, cantidad, cuenta, foto, mini, autor)
  values (v_nombre, v_tipo, p_ml, p_cantidad, public.chelas_por_ml(p_ml) * p_cantidad, p_foto, p_mini, v_autor)
  returning * into v_fila;
  return v_fila;
end
$$;

revoke execute on function public.nombre_disponible(text, text) from public;
grant execute on function public.nombre_disponible(text, text) to anon, authenticated;
