-- 0006: en Netlify la revisión corre en una función en segundo plano (responde 202 al momento),
-- así que la app pregunta el resultado con mi_chela. Lo que la IA descarta se borra, pero queda
-- un "recibo" 30 minutos (private.descartadas) para que su autor vea por qué no pasó.

create table private.descartadas (
  id bigint primary key,
  autor text not null,
  fila jsonb not null,
  creado timestamptz not null default now()
);
create index descartadas_creado_idx on private.descartadas (creado);

create or replace function public.ia_descartar(p_clave text, p_id bigint, p_motivo text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare v_fila public.chelas;
begin
  if not private.servidor_valido(p_clave) then raise exception 'no_autorizado'; end if;
  delete from public.chelas where id = p_id and estado = 'pendiente' returning * into v_fila;
  if v_fila.id is null then
    select * into v_fila from public.chelas where id = p_id;
    return jsonb_build_object('borrada', false, 'fila', case when v_fila.id is null then null else to_jsonb(v_fila) end);
  end if;
  v_fila.estado := 'rechazada';
  v_fila.motivo := p_motivo;
  v_fila.decidio := 'ia';
  delete from private.descartadas where creado < now() - interval '30 minutes';
  insert into private.descartadas (id, autor, fila) values (v_fila.id, v_fila.autor, to_jsonb(v_fila))
  on conflict (id) do nothing;
  return jsonb_build_object('borrada', true, 'fila', to_jsonb(v_fila));
end
$$;

-- Estado de una foto propia: la fila (cualquier estado) o, si la IA la descartó, su recibo.
create or replace function public.mi_chela(p_id bigint, p_secreto text)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  with yo as (select encode(extensions.digest(coalesce(p_secreto, ''), 'sha256'), 'hex') as autor)
  select coalesce(
    (select to_jsonb(c) from public.chelas c, yo where c.id = p_id and c.autor = yo.autor),
    (select d.fila from private.descartadas d, yo where d.id = p_id and d.autor = yo.autor)
  )
$$;

revoke execute on function public.mi_chela(bigint, text) from public;
grant execute on function public.mi_chela(bigint, text) to anon, authenticated;
