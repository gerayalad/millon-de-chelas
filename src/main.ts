// Millón de Chelas: marcador en vivo, álbum, ranking y el flujo "Sumar mi chela".
// Cada foto la revisa la IA (Worker: OpenRouter + Jev) antes de contar; ver worker/.

import * as api from './api';
import type { Chela, InfoIA } from './api';
import { MINI, comprimir, tarjeta } from './foto';
import { miAutor, perfil as perfilLocal, secreto, ultimoTamano } from './local';
import { Odometro, formato } from './odometro';
import { iniciarPWA, pintarAvisos } from './pwa';
import { CANTIDAD_MAX, META, ML_MAX, ML_MIN, TAMANOS, chelasPorMl, formatoMl, siguienteMeta } from './reglas';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const POR_PAGINA = 24;

let total = -1;
let meta = META;
/** Fotos aprobadas en pantalla, por id. */
const enPantalla = new Map<number, Chela>();
/** `orden` de la más vieja cargada (para "Ver más"). */
let masVieja: number | undefined;
let autor = '';
let periodo: 'hoy' | 'semana' | 'siempre' = 'hoy';
let tipoRanking: 'personas' | 'marcas' = 'personas';
let rankingCargado = false;

// ───────────────────────── utilidades de UI

function toast(texto: string, ms = 3200): void {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = texto;
  $('toasts').append(t);
  requestAnimationFrame(() => t.classList.add('visible'));
  setTimeout(() => {
    t.classList.remove('visible');
    setTimeout(() => t.remove(), 400);
  }, ms);
}

const reduceMovimiento = (): boolean => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** Lluvia de chelas que suben desde abajo. */
function fiesta(cuantas = 18): void {
  if (reduceMovimiento()) return;
  const capa = $('fiesta');
  for (let i = 0; i < cuantas; i++) {
    const s = document.createElement('span');
    s.textContent = Math.random() < 0.7 ? '🍺' : '🍻';
    s.style.left = `${Math.random() * 92 + 4}%`;
    s.style.animationDelay = `${Math.random() * 0.6}s`;
    s.style.fontSize = `${22 + Math.random() * 22}px`;
    s.style.setProperty('--giro', `${Math.random() * 60 - 30}deg`);
    capa.append(s);
    setTimeout(() => s.remove(), 3200);
  }
}

const rtf = new Intl.RelativeTimeFormat('es-MX', { numeric: 'auto', style: 'short' });

function hace(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'ahorita';
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  return rtf.format(-Math.round(s / 86400), 'day');
}

function chelasTexto(n: number): string {
  return n === 1 ? '1 chela' : `${formato(n)} chelas`;
}

function abrir(dlg: HTMLDialogElement): void {
  if (!dlg.open) dlg.showModal();
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, clase?: string, texto?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (clase) e.className = clase;
  if (texto !== undefined) e.textContent = texto;
  return e;
}

// Cerrar con × / "Listo" y tocando fuera de la hoja.
document.querySelectorAll<HTMLDialogElement>('dialog').forEach((dlg) => {
  dlg.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t === dlg || t.closest('[data-cerrar]')) dlg.close();
  });
});

/** Ficha de lo que vio la IA: marca, estilo, grados, origen, descripción y dato curioso. */
function pintarFichaIA(contenedor: HTMLElement, ia: InfoIA | null | undefined): void {
  contenedor.textContent = '';
  const titulo = ia?.marca || ia?.estilo;
  if (!ia || (!titulo && !ia.descripcion)) {
    contenedor.hidden = true;
    return;
  }
  const cabeza = el('div', 'ia-cabeza');
  cabeza.append(el('span', 'ia-sello', 'IA'), el('b', 'ia-marca', titulo || 'Cerveza'));
  contenedor.append(cabeza);
  const datos = [ia.marca ? ia.estilo : null, ia.abv, ia.origen].filter((x): x is string => !!x);
  if (datos.length) contenedor.append(el('p', 'ia-datos', datos.join(' · ')));
  if (ia.descripcion) contenedor.append(el('p', 'ia-desc', ia.descripcion));
  if (ia.dato) {
    const dato = el('p', 'ia-dato');
    dato.append(el('b', undefined, 'Dato chelero: '), document.createTextNode(ia.dato));
    contenedor.append(dato);
  }
  contenedor.hidden = false;
}

// ───────────────────────── marcador

const odometro = new Odometro($('total'));

/** Hito (desde) que tenía el vaso; al cambiar, se desborda y vuelve a empezar. */
let hitoDelVaso = -1;
let desborde: number | undefined;

/** La cerveza del marcador: sube con el avance del tramo actual (de un hito al siguiente). */
function llenarCerveza(fraccion: number, desde: number, animar: boolean): void {
  const cerveza = $('cerveza');
  const altura = (f: number): string => `${8 + Math.max(0, Math.min(1, f)) * 84}%`;
  const cruzo = animar && hitoDelVaso >= 0 && desde > hitoDelVaso;
  hitoDelVaso = desde;
  clearTimeout(desborde);
  if (!cruzo) {
    cerveza.classList.remove('desborda');
    cerveza.style.setProperty('--lleno', altura(fraccion));
    return;
  }
  // Cruzó un hito: se llena hasta arriba, se desborda y baja al nivel del tramo nuevo.
  cerveza.classList.add('desborda');
  cerveza.style.setProperty('--lleno', '104%');
  desborde = window.setTimeout(() => {
    cerveza.classList.remove('desborda');
    cerveza.style.setProperty('--lleno', altura(fraccion));
  }, 1900);
}

function pintarMarcador(nuevo: number, nuevaMeta = meta, animar = true): void {
  const anterior = total;
  total = nuevo;
  meta = nuevaMeta;
  odometro.set(total, animar);
  $('total').dataset['digits'] = String(formato(total).length);
  $('meta').textContent = formato(meta);

  const pct = Math.min(100, (total / meta) * 100);
  $('barra-relleno').style.width = `${pct}%`;
  $('barra').setAttribute('aria-valuenow', String(pct));
  const decimales = pct < 10 ? 2 : 1;
  const factor = 10 ** decimales;
  $('porcentaje').textContent = `${(Math.floor(pct * factor) / factor).toFixed(decimales)}%`;

  const hito = siguienteMeta(total);
  const hasta = Math.min(hito.hasta, meta);
  const completado = total >= meta;
  const desde = completado ? siguienteMeta(Math.max(0, meta - 1)).desde : Math.min(hito.desde, hasta);
  const fraccion = completado ? 1 : Math.max(0, Math.min(1, (total - desde) / Math.max(1, hasta - desde)));
  $('hito-etiqueta').textContent = completado ? 'Reto completado' : 'Siguiente hito';
  $('hito-meta').textContent = formato(hasta);
  $('siguiente').textContent = completado ? '¡Llegamos juntos a la meta!' : `${hasta - total === 1 ? 'Falta' : 'Faltan'} ${chelasTexto(hasta - total)}`;
  $('hito-desde').textContent = formato(desde);
  $('hito-hasta').textContent = formato(hasta);
  $('hito-relleno').style.width = `${fraccion * 100}%`;
  llenarCerveza(fraccion, desde, animar);
  $('hito-barra').setAttribute('aria-valuenow', (fraccion * 100).toFixed(2));
  $('hito-barra').setAttribute('aria-valuetext', `${formato(total)} chelas; tramo de ${formato(desde)} a ${formato(hasta)}`);
  $('barra').setAttribute('aria-valuetext', `${formato(total)} de ${formato(meta)} chelas`);

  // Cada millar cruzado se celebra; las metas grandes, con fiesta.
  if (animar && anterior >= 0 && Math.floor(anterior / 1000) < Math.floor(total / 1000)) {
    const millar = Math.floor(total / 1000) * 1000;
    const grande = siguienteMeta(anterior).hasta <= total;
    toast(`🎉 ¡Llegamos a ${formato(millar)} chelas!`, 5000);
    fiesta(grande ? 36 : 14);
  }
}

// ───────────────────────── álbum (solo aprobadas)

const listaFotos = $('fotos');

function subtitulo(c: Chela): string {
  return c.ia?.marca || c.tipo;
}

function tarjetaFoto(c: Chela): HTMLButtonElement {
  const b = el('button', 'foto');
  b.type = 'button';
  b.dataset['id'] = String(c.id);
  b.dataset['orden'] = String(c.orden ?? 0);
  if (c.autor === autor) b.classList.add('mia');

  const img = new Image();
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = `Chela de ${c.nombre}`;
  img.addEventListener('load', () => img.classList.add('cargada'), { once: true });
  img.src = api.urlFoto(c.mini ?? c.foto);
  b.append(img, el('span', 'foto-num', `#${formato(c.numero ?? 0)}`));

  if (c.cuenta > 1) b.append(el('span', 'foto-x', `×${c.cuenta}`));

  const pie = el('span', 'foto-pie');
  const cuando = el('small', undefined, `${subtitulo(c)} · ${hace(c.creado)}`);
  cuando.dataset['creado'] = c.creado;
  cuando.dataset['sub'] = subtitulo(c);
  pie.append(el('b', undefined, c.nombre), cuando);
  b.append(pie);

  b.addEventListener('click', () => abrirDetalle(c.id));
  return b;
}

function agregarFoto(c: Chela, donde: 'inicio' | 'final', nueva = false): void {
  if (enPantalla.has(c.id) || c.estado !== 'aprobada') return;
  enPantalla.set(c.id, c);
  const t = tarjetaFoto(c);
  if (nueva) t.classList.add('recien');
  if (donde === 'final') {
    listaFotos.append(t);
  } else {
    // Antes de la primera aprobada antes que ésta (casi siempre, hasta arriba).
    const orden = c.orden ?? Number.MAX_SAFE_INTEGER;
    const siguiente = [...listaFotos.children].find((x) => Number((x as HTMLElement).dataset['orden']) < orden);
    listaFotos.insertBefore(t, siguiente ?? null);
  }
  $('fotos-vacio').hidden = true;
}

function quitarFoto(id: number): void {
  enPantalla.delete(id);
  listaFotos.querySelector(`[data-id="${id}"]`)?.remove();
  $('fotos-vacio').hidden = enPantalla.size > 0;
  if (detalleId === id) $<HTMLDialogElement>('dlg-foto').close();
}

/** Un admin pudo denegar fotos ya aprobadas (no llega evento): se quitan las que ya no están. */
async function verificarVisibles(): Promise<void> {
  const ids = [...enPantalla.keys()];
  const siguen = await api.siguenAprobadas(ids);
  ids.filter((id) => !siguen.has(id)).forEach(quitarFoto);
}

function refrescarTiempos(): void {
  listaFotos.querySelectorAll<HTMLElement>('small[data-creado]').forEach((x) => {
    x.textContent = `${x.dataset['sub'] ?? ''} · ${hace(x.dataset['creado'] ?? '')}`;
  });
}
setInterval(refrescarTiempos, 60_000);

$('ver-mas').addEventListener('click', async () => {
  const boton = $<HTMLButtonElement>('ver-mas');
  boton.disabled = true;
  try {
    const lista = await api.leerChelas(masVieja, POR_PAGINA);
    lista.forEach((c) => agregarFoto(c, 'final'));
    if (lista.length) masVieja = lista[lista.length - 1]!.orden ?? masVieja;
    boton.hidden = lista.length < POR_PAGINA;
  } catch (e) {
    toast((e as Error).message);
  } finally {
    boton.disabled = false;
  }
});

// ───────────────────────── mis fotos en revisión

const misRevisiones = new Map<number, Chela>();
let revisionesTimer: number | undefined;

const ETIQUETA: Record<api.Estado, string> = {
  pendiente: 'La IA la está revisando…',
  revision: 'Con un admin 🧐',
  rechazada: 'No pasó ❌',
  aprobada: 'Aprobada',
};

function pintarMisRevisiones(): void {
  const caja = $('mis-revisiones');
  caja.textContent = '';
  const lista = [...misRevisiones.values()].sort((a, b) => b.id - a.id);
  caja.hidden = lista.length === 0;
  if (!lista.length) return;
  caja.append(el('p', 'eyebrow', 'Tus fotos que aún no cuentan'));
  for (const c of lista) {
    const fila = el('div', 'revision');
    fila.dataset['estado'] = c.estado;
    const img = new Image();
    img.alt = '';
    img.src = api.urlFoto(c.mini ?? c.foto);
    const texto = el('div', 'revision-texto');
    texto.append(el('b', undefined, ETIQUETA[c.estado]));
    texto.append(el('small', undefined, c.motivo || `${c.cantidad > 1 ? `${c.cantidad} × ` : ''}${c.tipo} · ${hace(c.creado)}`));
    fila.append(img, texto);
    if (c.estado === 'rechazada') {
      const quitar = el('button', 'enlace', 'Quitar');
      quitar.type = 'button';
      quitar.addEventListener('click', async () => {
        quitar.disabled = true;
        try {
          if (await api.borrar(c.id, secreto())) {
            misRevisiones.delete(c.id);
            pintarMisRevisiones();
          }
        } catch (e) {
          toast((e as Error).message);
          quitar.disabled = false;
        }
      });
      fila.append(quitar);
    }
    caja.append(fila);
  }
}

async function cargarMisRevisiones(): Promise<void> {
  try {
    const lista = await api.misRevisiones(secreto());
    misRevisiones.clear();
    lista.forEach((c) => misRevisiones.set(c.id, c));
    pintarMisRevisiones();
  } catch {
    /* no es crítico */
  }
  // Mientras haya pendientes, se vuelve a preguntar.
  clearTimeout(revisionesTimer);
  if ([...misRevisiones.values()].some((c) => c.estado === 'pendiente' || c.estado === 'revision')) {
    revisionesTimer = window.setTimeout(() => void cargarMisRevisiones(), 20_000);
  }
}

// ───────────────────────── detalle y borrar

let detalleId: number | null = null;
let confirmarBorrar = 0;

function abrirDetalle(id: number): void {
  const c = enPantalla.get(id);
  if (!c) return;
  detalleId = id;
  const numero = c.numero ?? 0;
  $<HTMLImageElement>('detalle-img').src = api.urlFoto(c.foto);
  $<HTMLImageElement>('detalle-img').alt = `Chela de ${c.nombre}`;
  $('foto-titulo').textContent =
    c.cuenta > 1 ? `#${formato(numero - c.cuenta + 1)} – #${formato(numero)}` : `Chela #${formato(numero)}`;
  const fecha = new Date(c.creado).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
  const cuantas = c.cantidad > 1 ? `${c.cantidad} × ` : '';
  $('detalle-info').textContent = `${c.nombre} · ${cuantas}${c.tipo} (${formatoMl(c.ml)}) = ${chelasTexto(c.cuenta)} · ${fecha}`;
  pintarFichaIA($('detalle-ia'), c.ia);
  const borrar = $<HTMLButtonElement>('borrar');
  borrar.hidden = c.autor !== autor;
  borrar.disabled = false;
  borrar.textContent = 'Borrar foto';
  confirmarBorrar = 0;
  abrir($<HTMLDialogElement>('dlg-foto'));
}

$('borrar').addEventListener('click', async () => {
  const c = detalleId !== null ? enPantalla.get(detalleId) : undefined;
  if (!c) return;
  const boton = $<HTMLButtonElement>('borrar');
  // Dos toques: el primero pide confirmación (sin confirm(), que bloquea la página).
  if (Date.now() - confirmarBorrar > 4000) {
    confirmarBorrar = Date.now();
    boton.textContent = `¿Seguro? Toca otra vez para restar ${chelasTexto(c.cuenta)}`;
    return;
  }
  boton.disabled = true;
  try {
    const ok = await api.borrar(c.id, secreto());
    if (!ok) throw new Error('No se pudo borrar (¿ya la habían borrado?).');
    quitarFoto(c.id);
    toast('Foto borrada y conteo corregido.');
  } catch (e) {
    toast((e as Error).message);
    boton.disabled = false;
  }
});

// ───────────────────────── ranking (cheleros o marcas)

function inicioPeriodo(): Date | null {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (periodo === 'hoy') return d;
  if (periodo === 'semana') {
    const dias = (d.getDay() + 6) % 7; // lunes = 0
    d.setDate(d.getDate() - dias);
    return d;
  }
  return null;
}

function filaRanking(pos: number, titulo: string, sub: string, cuantas: number, yo = false): HTMLLIElement {
  const medallas = ['🥇', '🥈', '🥉'];
  const li = el('li');
  if (yo) li.classList.add('yo');
  const quien = el('span', 'quien', titulo);
  quien.append(el('small', undefined, sub));
  li.append(el('span', 'pos', medallas[pos] ?? String(pos + 1)), quien, el('b', undefined, formato(cuantas)));
  return li;
}

async function cargarRanking(): Promise<void> {
  try {
    const ol = $('ranking');
    const fotos = (n: number): string => (n === 1 ? '1 foto' : `${n} fotos`);
    if (tipoRanking === 'personas') {
      const filas = await api.ranking(inicioPeriodo());
      const yo = (perfilLocal.get()?.nombre ?? '').toLowerCase();
      ol.replaceChildren(...filas.map((f, i) => filaRanking(i, f.nombre, fotos(f.fotos), f.chelas, f.nombre.toLowerCase() === yo)));
      $('ranking-vacio').hidden = filas.length > 0;
    } else {
      const filas = await api.rankingMarcas(inicioPeriodo());
      ol.replaceChildren(
        ...filas.map((f, i) => filaRanking(i, f.marca, [f.estilo, fotos(f.fotos)].filter(Boolean).join(' · '), f.chelas)),
      );
      $('ranking-vacio').hidden = filas.length > 0;
    }
    $('ranking-nota').textContent =
      tipoRanking === 'personas'
        ? 'El ranking cuenta solo las fotos aprobadas en la app.'
        : 'Marcas según lo que identificó la IA en cada foto.';
    rankingCargado = true;
  } catch (e) {
    toast((e as Error).message);
  }
}

let rankingPendiente: number | undefined;
function refrescarRankingPronto(): void {
  if ($('panel-ranking').hidden) {
    rankingCargado = false;
    return;
  }
  clearTimeout(rankingPendiente);
  rankingPendiente = window.setTimeout(() => void cargarRanking(), 1200);
}

document.querySelectorAll<HTMLButtonElement>('[data-periodo]').forEach((b) => {
  b.addEventListener('click', () => {
    periodo = b.dataset['periodo'] as typeof periodo;
    document.querySelectorAll('[data-periodo]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    void cargarRanking();
  });
});

document.querySelectorAll<HTMLButtonElement>('[data-tipo]').forEach((b) => {
  b.addEventListener('click', () => {
    tipoRanking = b.dataset['tipo'] as typeof tipoRanking;
    document.querySelectorAll('[data-tipo]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    void cargarRanking();
  });
});

// ───────────────────────── pestañas

function mostrarPestana(cual: 'fotos' | 'ranking'): void {
  $('tab-fotos').setAttribute('aria-selected', String(cual === 'fotos'));
  $('tab-ranking').setAttribute('aria-selected', String(cual === 'ranking'));
  $('panel-fotos').hidden = cual !== 'fotos';
  $('panel-ranking').hidden = cual !== 'ranking';
  if (cual === 'ranking' && !rankingCargado) void cargarRanking();
}
$('tab-fotos').addEventListener('click', () => mostrarPestana('fotos'));
$('tab-ranking').addEventListener('click', () => mostrarPestana('ranking'));

// ───────────────────────── sumar mi chela

const dlgRegistrar = $<HTMLDialogElement>('dlg-registrar');
const archivo = $<HTMLInputElement>('archivo');
const inputOtra = $<HTMLInputElement>('otra-ml');
const enviar = $<HTMLButtonElement>('enviar');

let fotoOriginal: File | null = null;
let fotoLista: Promise<Blob> | null = null;
let miniLista: Promise<Blob> | null = null;
let previewUrl = '';
/** Rutas ya subidas de la foto actual: si falla el registro, el reintento no la vuelve a subir. */
let rutasSubidas: { foto: string; mini: string } | null = null;
let tamanoId = '';
let cantidad = 1;
let enviando = false;

function mlActual(): number {
  if (tamanoId === 'otra') return Math.round(Number(inputOtra.value) || 0);
  return TAMANOS.find((t) => t.id === tamanoId)?.ml ?? 0;
}

function tipoActual(): string {
  if (tamanoId === 'otra') return 'Otra medida';
  return TAMANOS.find((t) => t.id === tamanoId)?.nombre ?? '';
}

function cuentaActual(): number {
  return chelasPorMl(mlActual()) * cantidad;
}

function actualizarEnviar(): void {
  if (enviando) return;
  const ml = mlActual();
  const n = cuentaActual();
  let texto: string;
  if (!fotoOriginal) texto = 'Falta la foto 📸';
  else if (!tamanoId) texto = 'Elige qué te estás tomando';
  else if (tamanoId === 'otra' && ml > ML_MAX) texto = 'Máximo 5 litros';
  else if (n === 0) texto = tamanoId === 'otra' && ml > 0 ? 'Menos de 250 ml no cuenta' : 'Escribe los mililitros';
  else texto = `¡Salud! Sumar ${chelasTexto(n)} 🍺`;
  enviar.textContent = texto;
  enviar.disabled = !texto.startsWith('¡Salud!');
}

function pintarChips(): void {
  const chips = $('chips');
  chips.textContent = '';
  const opciones = [
    ...TAMANOS.map((t) => ({ id: t.id, titulo: `${t.emoji} ${t.nombre}`, sub: formatoMl(t.ml), x: chelasPorMl(t.ml) })),
    { id: 'otra', titulo: '✏️ Otra medida', sub: 'en ml', x: 0 },
  ];
  for (const o of opciones) {
    const b = el('button', 'chip');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(o.id === tamanoId));
    b.append(el('span', 'chip-titulo', o.titulo), el('small', undefined, o.sub));
    if (o.x) b.append(el('b', 'chip-x', `×${o.x}`));
    b.addEventListener('click', () => {
      tamanoId = o.id;
      ultimoTamano.set(o.id);
      $('otra').hidden = o.id !== 'otra';
      if (o.id === 'otra') inputOtra.focus();
      pintarChips();
      actualizarEnviar();
    });
    chips.append(b);
  }
}

function ponerFoto(f: File): void {
  fotoOriginal = f;
  rutasSubidas = null;
  fotoLista = comprimir(f);
  miniLista = comprimir(f, MINI);
  fotoLista.catch(() => undefined);
  miniLista.catch(() => undefined);
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(f);
  const img = $<HTMLImageElement>('preview-img');
  img.src = previewUrl;
  img.hidden = false;
  $('preview-vacio').hidden = true;
  $('preview-cambiar').hidden = false;
}

function abrirRegistro(): void {
  $('registrar-error').textContent = '';
  $('sumando-nombre').textContent = perfilLocal.get()?.nombre ?? '—';
  if (!tamanoId) {
    const ultimo = ultimoTamano.get();
    if (ultimo && (ultimo === 'otra' || TAMANOS.some((t) => t.id === ultimo))) tamanoId = ultimo;
  }
  $('otra').hidden = tamanoId !== 'otra';
  pintarChips();
  $('cantidad').textContent = String(cantidad);
  actualizarEnviar();
  abrir(dlgRegistrar);
}

/** Directo a la cámara / galería (al elegir foto se abre la hoja). Sin perfil, primero el perfil. */
function sumar(): void {
  if (!perfilLocal.get()) abrirPerfil('primera');
  else archivo.click();
}

$('sumar').addEventListener('click', sumar);
$('estrenar').addEventListener('click', sumar);

$('preview').addEventListener('click', () => archivo.click());

archivo.addEventListener('change', () => {
  const f = archivo.files?.[0];
  archivo.value = '';
  if (!f) return;
  if (f.type && !f.type.startsWith('image/')) {
    toast('Eso no parece una foto 🤔');
    return;
  }
  ponerFoto(f);
  abrirRegistro();
});

$('menos').addEventListener('click', () => {
  cantidad = Math.max(1, cantidad - 1);
  $('cantidad').textContent = String(cantidad);
  actualizarEnviar();
});
$('mas').addEventListener('click', () => {
  cantidad = Math.min(CANTIDAD_MAX, cantidad + 1);
  $('cantidad').textContent = String(cantidad);
  actualizarEnviar();
});
inputOtra.addEventListener('input', actualizarEnviar);
$('cambiar-perfil').addEventListener('click', () => abrirPerfil('editar'));

function limpiarRegistro(): void {
  fotoOriginal = null;
  fotoLista = null;
  miniLista = null;
  rutasSubidas = null;
  cantidad = 1;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = '';
  const img = $<HTMLImageElement>('preview-img');
  img.removeAttribute('src');
  img.hidden = true;
  $('preview-vacio').hidden = false;
  $('preview-cambiar').hidden = true;
}

$('form-registrar').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (enviando || enviar.disabled || !fotoLista || !miniLista) return;
  const ml = mlActual();
  if (ml < ML_MIN) return;
  enviando = true;
  enviar.disabled = true;
  $('registrar-error').textContent = '';
  const nombre = perfilLocal.get()?.nombre ?? '';
  try {
    enviar.textContent = 'Subiendo foto…';
    const [foto, mini] = await Promise.all([fotoLista, miniLista]).catch(() => {
      throw new Error('No pudimos leer esa foto. Prueba con otra o tómala de nuevo.');
    });
    if (!rutasSubidas) rutasSubidas = await api.subirFoto(foto, mini);
    enviar.textContent = 'Registrando…';
    const c = await api.registrar({ nombre, tipo: tipoActual(), ml, cantidad, ...rutasSubidas, secreto: secreto() });
    enviando = false;
    dlgRegistrar.close();
    limpiarRegistro();
    void revisarMiChela(c, foto);
  } catch (err) {
    enviando = false;
    $('registrar-error').textContent = (err as Error).message;
    actualizarEnviar();
    // El perfil se borró o nunca llegó a la base: se vuelve a pedir.
    if ((err as Error).message === 'Primero crea tu nombre chelero.') {
      perfilLocal.set(null);
      abrirPerfil('primera');
    }
  }
});

// ───────────────────────── revisión con IA y resultado

let archivoTarjeta: File | null = null;
let numeroSalud = 0;
/** La foto propia cuyo resultado está esperando la hoja (para resolver por tiempo real). */
let esperando: { id: number; foto: Blob } | null = null;
let fotoSaludUrl = '';

function estadoSalud(estado: 'revisando' | api.Estado, eyebrow: string, titulo: string, texto: string): void {
  $('salud').dataset['estado'] = estado;
  $('salud-eyebrow').textContent = eyebrow;
  $('salud-titulo').textContent = titulo;
  $('salud-texto').textContent = texto;
}

async function revisarMiChela(c: Chela, foto: Blob): Promise<void> {
  esperando = { id: c.id, foto };
  archivoTarjeta = null;
  if (fotoSaludUrl) URL.revokeObjectURL(fotoSaludUrl);
  fotoSaludUrl = URL.createObjectURL(foto);
  $<HTMLImageElement>('salud-foto').src = fotoSaludUrl;
  $('salud-ia').hidden = true;
  $('salud-tarjeta').hidden = true;
  $('compartir').hidden = true;
  estadoSalud('revisando', 'Un momento 🤖', 'Revisando tu chela…', 'La IA está checando que sea cerveza y qué cerveza es.');
  abrir($<HTMLDialogElement>('dlg-salud'));
  misRevisiones.set(c.id, c);
  pintarMisRevisiones();

  let r = await api.revisar(c.id);
  // Si el Worker no terminó (otro intento, IA lenta), se pregunta un rato más.
  for (let i = 0; (!r || r.estado === 'pendiente') && i < 6 && esperando?.id === c.id; i++) {
    await new Promise((ok) => setTimeout(ok, 4000));
    r = await consultar(c.id);
  }
  if (esperando?.id !== c.id) return; // ya se resolvió por tiempo real
  mostrarResultado(r ?? c, foto);
}

/** Estado actual de una foto propia: aprobada (visible para todos) o entre mis revisiones. */
async function consultar(id: number): Promise<Chela | null> {
  try {
    const aprobada = await api.leerChela(id);
    if (aprobada) return aprobada;
    return (await api.misRevisiones(secreto())).find((x) => x.id === id) ?? null;
  } catch {
    return null;
  }
}

const sinPunto = (t: string): string => t.trim().replace(/\.+$/, '');

function mostrarResultado(c: Chela, foto: Blob): void {
  if (esperando?.id === c.id) esperando = null;
  if (c.estado === 'aprobada') {
    misRevisiones.delete(c.id);
    pintarMisRevisiones();
    agregarFoto(c, 'inicio', true);
    if ((c.numero ?? 0) > total) pintarMarcador(c.numero ?? 0);
    mostrarSalud(c, foto);
    refrescarRankingPronto();
    return;
  }
  if (c.estado === 'rechazada') {
    // Lo que la IA rechaza no se guarda: ni foto ni registro.
    misRevisiones.delete(c.id);
    pintarMisRevisiones();
    $('salud-ia').hidden = true;
    estadoSalud(
      'rechazada',
      'Mmm…',
      'Eso no parece chela 🤨',
      `${sinPunto(c.motivo ?? 'La IA no vio una cerveza en la foto')}. No se guardó; si sí era chela, tómale otra foto donde se vea bien.`,
    );
    return;
  }
  misRevisiones.set(c.id, c);
  pintarMisRevisiones();
  void cargarMisRevisiones();
  pintarFichaIA($('salud-ia'), c.ia);
  if (c.estado === 'revision') {
    estadoSalud(
      'revision',
      'Casi…',
      'En revisión 🧐',
      `${sinPunto(c.motivo ?? 'La IA no está segura')}. Un admin la revisa y, si pasa, se suma con su número. Aquí te avisamos.`,
    );
  } else {
    estadoSalud(
      'revision',
      'Paciencia',
      'La IA se está tardando ⏳',
      'Tu foto ya está guardada. En cuanto quede revisada se suma al conteo; aquí te avisamos.',
    );
  }
}

function mostrarSalud(c: Chela, foto: Blob): void {
  const numero = c.numero ?? 0;
  numeroSalud = numero;
  archivoTarjeta = null;
  estadoSalud(
    'aprobada',
    `¡Salud, ${c.nombre}! 🍻`,
    `#${formato(numero)}`,
    c.cuenta > 1
      ? `Sumaste ${chelasTexto(c.cuenta)}: de la #${formato(numero - c.cuenta + 1)} a la #${formato(numero)}.`
      : `Tu chela es la número ${formato(numero)} rumbo al millón.`,
  );
  pintarFichaIA($('salud-ia'), c.ia);
  const img = $<HTMLImageElement>('salud-tarjeta');
  img.hidden = true;
  const compartir = $<HTMLButtonElement>('compartir');
  compartir.hidden = false;
  compartir.disabled = true;
  compartir.textContent = 'Preparando foto…';
  abrir($<HTMLDialogElement>('dlg-salud'));
  fiesta();
  if (navigator.vibrate) navigator.vibrate([20, 40, 20]);

  const quien = c.cuenta > 1 ? `${c.nombre} ×${c.cuenta}` : c.nombre;
  const pie = c.ia?.marca ? `${quien} · ${c.ia.marca}` : quien;
  tarjeta(foto, { numero: formato(numero), meta: `de ${formato(meta)}`, pie })
    .then((blob) => {
      archivoTarjeta = new File([blob], `chela-${numero}.jpg`, { type: 'image/jpeg' });
      if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
      img.src = URL.createObjectURL(blob);
      img.hidden = false;
    })
    .catch(() => undefined)
    .finally(() => {
      compartir.disabled = false;
      compartir.textContent = 'Mandar al grupo 📲';
    });
}

$('compartir').addEventListener('click', async () => {
  const texto = `${formato(numeroSalud)} 🍺`;
  try {
    if (archivoTarjeta && navigator.canShare?.({ files: [archivoTarjeta] })) {
      await navigator.share({ files: [archivoTarjeta], text: texto });
      return;
    }
    if (navigator.share) {
      await navigator.share({ text: texto });
      return;
    }
  } catch (e) {
    if ((e as DOMException).name === 'AbortError') return;
  }
  // Escritorio: descarga la foto y copia el número.
  if (archivoTarjeta) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(archivoTarjeta);
    a.download = archivoTarjeta.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  try {
    await navigator.clipboard.writeText(texto);
    toast('Foto descargada y número copiado 📋');
  } catch {
    toast('Foto descargada');
  }
});

// ───────────────────────── ajustes

function pintarResumenPerfil(): void {
  const p = perfilLocal.get();
  $('ajustes-nombre').textContent = p?.nombre ?? 'Sin nombre chelero';
  $('ajustes-tel').textContent = p ? (p.telefono ? p.telefono.replace(/^\+52(\d{2})(\d{4})(\d{4})$/, '$1 $2 $3') : 'Sin teléfono') : '';
  $('editar-perfil').textContent = p ? 'Editar' : 'Crear';
}

$('abrir-ajustes').addEventListener('click', () => {
  pintarResumenPerfil();
  void pintarAvisos();
  abrir($<HTMLDialogElement>('dlg-ajustes'));
});
$('editar-perfil').addEventListener('click', () => abrirPerfil(perfilLocal.get() ? 'editar' : 'primera'));

// ───────────────────────── perfil: nombre chelero (único) y teléfono opcional

const dlgPerfil = $<HTMLDialogElement>('dlg-perfil');
const perfilNombre = $<HTMLInputElement>('perfil-nombre');
const perfilTel = $<HTMLInputElement>('perfil-tel');
const NOMBRE_VALIDO = /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9_.]{3,20}$/;
const AYUDA_NOMBRE = '3 a 20 letras o números, sin espacios (se vale _ y .). Así te verán en el álbum y el ranking.';
let modoPerfil: 'primera' | 'editar' = 'primera';
let revisionNombre: number | undefined;
let confirmarBorrarPerfil = 0;

function estadoNombre(texto: string, tipo: '' | 'ok' | 'mal'): void {
  const e = $('perfil-nombre-estado');
  e.textContent = texto;
  e.dataset['tipo'] = tipo;
}

function abrirPerfil(modo: 'primera' | 'editar'): void {
  modoPerfil = modo;
  const p = perfilLocal.get();
  perfilNombre.value = p?.nombre ?? '';
  // En la base va como +52XXXXXXXXXX; aquí solo los 10 dígitos.
  perfilTel.value = (p?.telefono ?? '').replace(/^\+52/, '').replace(/\D/g, '').slice(0, 10);
  $('perfil-eyebrow').textContent = modo === 'primera' ? 'Antes de tu primera chela' : 'Tu perfil';
  $('perfil-titulo').textContent = modo === 'primera' ? '¿Cómo te conocen en el grupo?' : 'Edita tu perfil';
  $('perfil-guardar').hidden = false;
  $<HTMLButtonElement>('perfil-guardar').disabled = false;
  $('perfil-guardar').textContent = modo === 'primera' ? 'Crear mi perfil' : 'Guardar cambios';
  $('perfil-foto').hidden = true;
  $('perfil-borrar').hidden = modo === 'primera' || !p;
  $('perfil-borrar').textContent = 'Borrar mis datos';
  confirmarBorrarPerfil = 0;
  $('perfil-error').textContent = '';
  estadoNombre(AYUDA_NOMBRE, '');
  abrir(dlgPerfil);
}

perfilNombre.addEventListener('input', () => {
  const v = perfilNombre.value.trim();
  clearTimeout(revisionNombre);
  if (!v) return estadoNombre(AYUDA_NOMBRE, '');
  if (!NOMBRE_VALIDO.test(v)) return estadoNombre(/\s/.test(v) ? 'Sin espacios: prueba con _ o junto.' : AYUDA_NOMBRE, 'mal');
  estadoNombre('Revisando…', '');
  revisionNombre = window.setTimeout(async () => {
    try {
      const libre = await api.nombreDisponible(v, secreto());
      if (perfilNombre.value.trim() !== v) return;
      estadoNombre(libre ? `✓ ${v} está libre` : `✗ ${v} ya lo tiene alguien`, libre ? 'ok' : 'mal');
    } catch {
      estadoNombre(AYUDA_NOMBRE, '');
    }
  }, 400);
});

// Solo números. Al pegar "+52 55 1234 5678" o "+52 1 55…" se quita la lada de país.
perfilTel.addEventListener('input', () => {
  let d = perfilTel.value.replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('521')) d = d.slice(3);
  else if (d.length === 12 && d.startsWith('52')) d = d.slice(2);
  perfilTel.value = d.slice(0, 10);
});

$('form-perfil').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nombre = perfilNombre.value.trim();
  if (!NOMBRE_VALIDO.test(nombre)) {
    estadoNombre(AYUDA_NOMBRE, 'mal');
    perfilNombre.focus();
    return;
  }
  if (perfilTel.value && perfilTel.value.length !== 10) {
    $('perfil-error').textContent = 'Tu teléfono: 10 dígitos (o déjalo vacío).';
    perfilTel.focus();
    return;
  }
  const boton = $<HTMLButtonElement>('perfil-guardar');
  boton.disabled = true;
  $('perfil-error').textContent = '';
  const anterior = perfilLocal.get()?.nombre;
  try {
    const p = await api.guardarPerfil(secreto(), {
      nombre,
      telefono: perfilTel.value,
      aceptaPromos: false,
    });
    perfilLocal.set(p);
    pintarResumenPerfil();
    $('sumando-nombre').textContent = p.nombre;
    if (anterior && anterior !== p.nombre) {
      // Sus fotos se renombraron en la base: se refleja en el álbum y el ranking.
      listaFotos.querySelectorAll<HTMLElement>('.foto.mia .foto-pie b').forEach((b) => (b.textContent = p.nombre));
      enPantalla.forEach((c) => {
        if (c.autor === autor) c.nombre = p.nombre;
      });
      rankingCargado = false;
      refrescarRankingPronto();
    }
    if (modoPerfil === 'primera') {
      // El selector de fotos necesita un toque directo del usuario: segundo botón.
      $('perfil-eyebrow').textContent = '¡Listo!';
      $('perfil-titulo').textContent = `Bienvenido, ${p.nombre} 🍻`;
      boton.hidden = true;
      $('perfil-foto').hidden = false;
    } else {
      dlgPerfil.close();
      toast(`Perfil guardado, ${p.nombre} 🍻`);
    }
  } catch (err) {
    $('perfil-error').textContent = (err as Error).message;
    boton.disabled = false;
  }
});

$('perfil-foto').addEventListener('click', () => {
  dlgPerfil.close();
  archivo.click();
});

$('perfil-borrar').addEventListener('click', async () => {
  const boton = $<HTMLButtonElement>('perfil-borrar');
  if (Date.now() - confirmarBorrarPerfil > 4000) {
    confirmarBorrarPerfil = Date.now();
    boton.textContent = '¿Seguro? Toca otra vez (tus fotos se quedan)';
    return;
  }
  boton.disabled = true;
  try {
    await api.borrarPerfil(secreto());
    perfilLocal.set(null);
    pintarResumenPerfil();
    dlgPerfil.close();
    toast('Borramos tu nombre chelero y tu teléfono.');
  } catch (err) {
    $('perfil-error').textContent = (err as Error).message;
  } finally {
    boton.disabled = false;
  }
});

// ───────────────────────── arranque y tiempo real

let conectadoAntes = false;

async function sincronizar(): Promise<void> {
  const [m, lista] = await Promise.all([api.leerMarcador(), api.leerChelas(undefined, POR_PAGINA)]);
  pintarMarcador(m.total, m.meta, total >= 0);
  // agregarFoto('inicio') inserta por orden; las más viejas que la última página no se tocan.
  lista.filter((c) => masVieja === undefined || (c.orden ?? 0) >= masVieja).forEach((c) => agregarFoto(c, 'inicio'));
  if (masVieja === undefined && lista.length) {
    masVieja = lista[lista.length - 1]!.orden ?? undefined;
    $('ver-mas').hidden = lista.length < POR_PAGINA;
  }
  $('fotos-vacio').hidden = enPantalla.size > 0;
  void verificarVisibles().catch(() => undefined);
  void cargarMisRevisiones();
}

/** La base manda: si el perfil cambió o se borró en otro lado, se actualiza la copia local. */
async function sincronizarPerfil(): Promise<void> {
  try {
    perfilLocal.set(await api.miPerfil(secreto()));
  } catch {
    /* sin red: se queda la copia local */
  }
}

async function iniciar(): Promise<void> {
  autor = await miAutor().catch(() => '');
  void sincronizarPerfil();

  try {
    const [m, lista] = await Promise.all([api.leerMarcador(), api.leerChelas(undefined, POR_PAGINA)]);
    pintarMarcador(m.total, m.meta, false);
    lista.forEach((c) => agregarFoto(c, 'final'));
    if (lista.length) masVieja = lista[lista.length - 1]!.orden ?? undefined;
    $('ver-mas').hidden = lista.length < POR_PAGINA;
    $('fotos-vacio').hidden = lista.length > 0;
  } catch (e) {
    $('en-vivo').dataset['estado'] = 'off';
    $('en-vivo').textContent = 'Sin conexión';
    toast(`${(e as Error).message} Reintentando…`, 3800);
    setTimeout(() => void iniciar(), 4000);
    return;
  }
  void cargarMisRevisiones();

  api.escuchar({
    aprobada(c) {
      const nueva = !enPantalla.has(c.id);
      if (c.autor === autor) {
        if (esperando?.id === c.id) {
          mostrarResultado(c, esperando.foto);
          return;
        }
        if (misRevisiones.delete(c.id)) {
          pintarMisRevisiones();
          toast(`✅ ¡Aprobaron tu chela! Quedó como la #${formato(c.numero ?? 0)}`, 5000);
        }
      } else if (nueva) {
        toast(`🍺 ${c.nombre} sumó ${chelasTexto(c.cuenta)} · #${formato(c.numero ?? 0)}`);
      }
      agregarFoto(c, 'inicio', nueva);
      refrescarRankingPronto();
    },
    borrada(id) {
      quitarFoto(id);
      refrescarRankingPronto();
    },
    marcador(m) {
      if (typeof m.total !== 'number') return;
      const bajo = total >= 0 && m.total < total;
      pintarMarcador(m.total, m.meta ?? meta);
      if (bajo) void verificarVisibles().catch(() => undefined);
    },
    estado(conectado) {
      $('en-vivo').dataset['estado'] = conectado ? 'ok' : 'off';
      $('en-vivo').textContent = conectado ? 'En vivo' : 'Reconectando';
      // Al reconectar (celular que volvió de segundo plano) se recupera lo que pasó mientras.
      if (conectado && conectadoAntes) void sincronizar().catch(() => undefined);
      if (conectado) conectadoAntes = true;
    },
  });
}

let ocultaDesde = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    ocultaDesde = Date.now();
  } else if (ocultaDesde && Date.now() - ocultaDesde > 20_000 && total >= 0) {
    void sincronizar().catch(() => undefined);
    refrescarTiempos();
  }
});

iniciarPWA({ toast });
void iniciar();
