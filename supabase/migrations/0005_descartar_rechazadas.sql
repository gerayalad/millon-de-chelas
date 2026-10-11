-- 0005: lo que la IA rechaza (Jev: no es cerveza) no se guarda. El Worker borra la fila con
-- ia_descartar y luego los archivos (foto y miniatura) con la llave secreta de Supabase.
-- Solo las que deniega un admin quedan como 'rechazada' (por si hay que corregir).

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
    -- Ya la decidió un admin (o no existe): no se toca.
    select * into v_fila from public.chelas where id = p_id;
    return jsonb_build_object('borrada', false, 'fila', case when v_fila.id is null then null else to_jsonb(v_fila) end);
  end if;
  v_fila.estado := 'rechazada';
  v_fila.motivo := p_motivo;
  v_fila.decidio := 'ia';
  return jsonb_build_object('borrada', true, 'fila', to_jsonb(v_fila));
end
$$;

revoke execute on function public.ia_descartar(text, bigint, text) from public;
grant execute on function public.ia_descartar(text, bigint, text) to anon, authenticated;
