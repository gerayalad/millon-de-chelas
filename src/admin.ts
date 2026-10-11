// Panel de admin (/admin): entrada con PIN y cola de fotos para autorizar o denegar.
// Todo pasa por funciones admin_* de la base, que validan el PIN en cada llamada (y bloquean
// 10 minutos tras 15 fallos).

import * as api from './api';
import type { Chela, Estado } from './api';
import { pinAdmin } from './local';
import { formato } from './odometro';
import { formatoMl } from './reglas';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

type Vista = 'por_revisar' | 'rechazada' | 'aprobada';

const VISTAS: Record<Vista, { estados: Estado[]; titulo: string; nota: string }> = {
  por_revisar: {
    estados: ['revision', 'pendiente'],
    titulo: 'Por revisar',
    nota: 'La IA no estuvo segura o lo declarado no cuadra. Autorizar la suma al conteo con su número.',
  },
  rechazada: {
    estados: ['rechazada'],
    titulo: 'Rechazadas',
    nota: 'Las que denegó un admin (lo que la IA rechaza ni se guarda). Si fue un error, autorízala.',
  },
  aprobada: {
    estados: ['aprobada'],
    titulo: 'Aprobadas',
    nota: 'Ya cuentan. Denegar una la quita del álbum y resta sus chelas del marcador.',
  },
};

let pin = '';
let vista: Vista = 'por_revisar';
let masVieja: number | undefined;
let refresco: number | undefined;

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

function el<K extends keyof HTMLElementTagNameMap>(tag: K, clase?: string, texto?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (clase) e.className = clase;
  if (texto !== undefined) e.textContent = texto;
  return e;
}

const rtf = new Intl.RelativeTimeFormat('es-MX', { numeric: 'auto', style: 'short' });
function hace(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'ahorita';
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  return rtf.format(-Math.round(s / 86400), 'day');
}

document.querySelectorAll<HTMLDialogElement>('dialog').forEach((dlg) => {
  dlg.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t === dlg || t.closest('[data-cerrar]')) dlg.close();
  });
});

// ───────────────────────── PIN

const pinInput = $<HTMLInputElement>('pin-input');

function pintarPuntos(): void {
  const n = pinInput.value.length;
  $('pin-puntos')
    .querySelectorAll('span')
    .forEach((s, i) => s.classList.toggle('lleno', i < n));
}

async function probarPin(): Promise<void> {
  const intento = pinInput.value;
  if (intento.length !== 6) return;
  $('pin-error').textContent = '';
  try {
    if (await api.adminEntrar(intento)) {
      entrar(intento);
      return;
    }
    $('pin-error').textContent = 'PIN incorrecto.';
  } catch (e) {
    $('pin-error').textContent = (e as Error).message;
  }
  $('pin-puntos').classList.remove('sacude');
  void $('pin-puntos').offsetWidth;
  $('pin-puntos').classList.add('sacude');
  pinInput.value = '';
  pintarPuntos();
}

pinInput.addEventListener('input', () => {
  pinInput.value = pinInput.value.replace(/\D/g, '').slice(0, 6);
  pintarPuntos();
  void probarPin();
});

$('teclado').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (!b) return;
  if (b.id === 'pin-borrar') pinInput.value = pinInput.value.slice(0, -1);
  else if (pinInput.value.length < 6) pinInput.value += b.dataset['d'] ?? '';
  pintarPuntos();
  void probarPin();
});

function entrar(valido: string): void {
  pin = valido;
  pinAdmin.set(valido);
  pinInput.value = '';
  pintarPuntos();
  $('pantalla-pin').hidden = true;
  $('pantalla-panel').hidden = false;
  $('salir').hidden = false;
  void cargar();
  clearInterval(refresco);
  refresco = window.setInterval(() => {
    if (!document.hidden) void cargar(true);
  }, 15_000);
}

function salir(mensaje?: string): void {
  pin = '';
  pinAdmin.set(null);
  clearInterval(refresco);
  $('pantalla-panel').hidden = true;
  $('pantalla-pin').hidden = false;
  $('salir').hidden = true;
  $('pin-error').textContent = mensaje ?? '';
  // En celular se usa el teclado en pantalla; el input es para escribir en la compu.
  if (window.matchMedia?.('(pointer: fine)').matches) pinInput.focus();
}

$('salir').addEventListener('click', () => salir());

// ───────────────────────── cola

function porcentaje(p: number | null | undefined): string {
  return typeof p === 'number' ? `${Math.round(p * 100)}%` : '—';
}

function tarjeta(c: Chela): HTMLElement {
  const art = el('article', 'caso');
  art.dataset['id'] = String(c.id);
  art.dataset['estado'] = c.estado;

  const ver = el('button', 'caso-foto');
  ver.type = 'button';
  ver.setAttribute('aria-label', 'Ver foto completa');
  const img = new Image();
  img.loading = 'lazy';
  img.alt = '';
  img.src = api.urlFoto(c.mini ?? c.foto);
  ver.append(img);
  if (c.numero !== null && c.estado === 'aprobada') ver.append(el('span', 'foto-num', `#${formato(c.numero)}`));
  ver.addEventListener('click', () => {
    $<HTMLImageElement>('ver-img').src = api.urlFoto(c.foto);
    $<HTMLDialogElement>('dlg-ver').showModal();
  });

  const cuerpo = el('div', 'caso-cuerpo');
  const cabeza = el('div', 'caso-cabeza');
  cabeza.append(el('b', undefined, c.nombre), el('small', undefined, hace(c.creado)));
  cuerpo.append(cabeza);

  const cuantas = c.cantidad > 1 ? `${c.cantidad} × ` : '';
  cuerpo.append(el('p', 'caso-declarado', `Declaró: ${cuantas}${c.tipo} (${formatoMl(c.ml)}) = ${c.cuenta} ${c.cuenta === 1 ? 'chela' : 'chelas'}`));

  const ia = c.ia;
  const medidores = el('div', 'medidores');
  if (c.estado === 'pendiente' && !ia) {
    medidores.append(el('span', 'medidor', '🤖 La IA la está revisando…'));
  } else {
    const es = el('span', 'medidor', `Cerveza ${porcentaje(c.jev)}`);
    es.dataset['nivel'] = c.jev == null ? '' : c.jev >= 0.8 ? 'alto' : c.jev <= 0.2 ? 'bajo' : 'medio';
    medidores.append(es);
    if (typeof ia?.cuadra === 'number') {
      const cu = el('span', 'medidor', `Cuadra ${porcentaje(ia.cuadra)}`);
      cu.dataset['nivel'] = ia.cuadra >= 0.3 ? 'alto' : 'bajo';
      medidores.append(cu);
    }
    if (typeof ia?.cantidad_visible === 'number') medidores.append(el('span', 'medidor', `Ve ${ia.cantidad_visible}`));
  }
  cuerpo.append(medidores);

  if (ia?.resumen) cuerpo.append(el('p', 'caso-resumen', `IA: ${ia.resumen}`));
  const marca = [ia?.marca, ia?.estilo].filter(Boolean).join(' · ');
  if (marca) cuerpo.append(el('p', 'caso-marca', marca));
  if (c.motivo) cuerpo.append(el('p', 'caso-motivo', c.motivo));
  if (c.decidio) cuerpo.append(el('small', 'caso-quien', c.decidio === 'admin' ? 'Decidió un admin' : 'Decidió la IA'));

  const acciones = el('div', 'caso-acciones');
  if (c.estado !== 'aprobada') {
    const si = el('button', 'boton', '✓ Autorizar');
    si.type = 'button';
    si.addEventListener('click', () => void decidir(c, 'aprobada', art));
    acciones.append(si);
  }
  if (c.estado !== 'rechazada') {
    const no = el('button', 'boton-peligro', '✕ Denegar');
    no.type = 'button';
    no.addEventListener('click', () => void decidir(c, 'rechazada', art));
    acciones.append(no);
  }
  cuerpo.append(acciones);

  art.append(ver, cuerpo);
  return art;
}

async function decidir(c: Chela, decision: 'aprobada' | 'rechazada', art: HTMLElement): Promise<void> {
  art.querySelectorAll('button').forEach((b) => (b.disabled = true));
  try {
    const r = await api.adminDecidir(pin, c.id, decision);
    if (!r) {
      salir('Tu PIN ya no es válido. Entra de nuevo.');
      return;
    }
    toast(
      r.estado === 'aprobada'
        ? `✓ Autorizada: ${r.nombre} quedó como la #${formato(r.numero ?? 0)}`
        : `✕ Denegada${c.estado === 'aprobada' ? `: se restaron ${c.cuenta} del marcador` : ''}`,
    );
    art.classList.add('saliendo');
    setTimeout(() => {
      art.remove();
      $('cola-vacia').hidden = $('cola').children.length > 0;
    }, 300);
    void cargarConteos();
  } catch (e) {
    toast((e as Error).message);
    art.querySelectorAll('button').forEach((b) => (b.disabled = false));
  }
}

async function cargarConteos(): Promise<boolean> {
  // Sin PIN no se llama: cada llamada con PIN equivocado cuenta para el bloqueo.
  if (!pin) return false;
  const n = await api.adminConteos(pin);
  if (!n) {
    salir('Tu PIN ya no es válido. Entra de nuevo.');
    return false;
  }
  $('n-por-revisar').textContent = formato((n.revision ?? 0) + (n.pendiente ?? 0));
  $('n-rechazada').textContent = formato(n.rechazada ?? 0);
  $('n-aprobada').textContent = formato(n.aprobada ?? 0);
  return true;
}

/** `silencioso`: refresco automático; solo agrega lo nuevo arriba si estás en la primera página. */
async function cargar(silencioso = false): Promise<void> {
  try {
    if (!(await cargarConteos())) return;
    const v = VISTAS[vista];
    const lista = await api.adminListar(pin, v.estados);
    const cola = $('cola');
    if (silencioso) {
      const ids = new Set([...cola.children].map((x) => Number((x as HTMLElement).dataset['id'])));
      const nuevas = lista.filter((c) => !ids.has(c.id) && c.id > Math.max(0, ...ids));
      cola.prepend(...nuevas.map(tarjeta));
    } else {
      cola.replaceChildren(...lista.map(tarjeta));
      masVieja = lista.length ? lista[lista.length - 1]!.id : undefined;
      $('cola-mas').hidden = lista.length < 30;
    }
    $('cola-vacia').hidden = cola.children.length > 0;
  } catch (e) {
    if (!silencioso) toast((e as Error).message);
  }
}

$('cola-mas').addEventListener('click', async () => {
  const boton = $<HTMLButtonElement>('cola-mas');
  boton.disabled = true;
  try {
    const lista = await api.adminListar(pin, VISTAS[vista].estados, masVieja);
    $('cola').append(...lista.map(tarjeta));
    if (lista.length) masVieja = lista[lista.length - 1]!.id;
    boton.hidden = lista.length < 30;
  } catch (e) {
    toast((e as Error).message);
  } finally {
    boton.disabled = false;
  }
});

function cambiarVista(v: Vista): void {
  vista = v;
  document.querySelectorAll<HTMLButtonElement>('[data-vista]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset['vista'] === v)));
  const titulo = $('vista-titulo');
  titulo.textContent = VISTAS[v].titulo;
  titulo.append(el('span', undefined, '.'));
  $('vista-nota').textContent = VISTAS[v].nota;
  $('cola').textContent = '';
  if (pin) void cargar();
}

document.querySelectorAll<HTMLButtonElement>('[data-vista]').forEach((b) => {
  b.addEventListener('click', () => cambiarVista(b.dataset['vista'] as Vista));
});
$('refrescar').addEventListener('click', () => void cargar());

$('form-ajustar').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('ajustar-total');
  const n = Math.round(Number(input.value));
  if (!input.value || !Number.isFinite(n) || n < 0) return;
  try {
    const nuevo = await api.adminAjustarTotal(pin, n);
    if (nuevo === null) {
      salir('Tu PIN ya no es válido. Entra de nuevo.');
      return;
    }
    input.value = '';
    toast(`Conteo ajustado a ${formato(nuevo)}`);
  } catch (err) {
    toast((err as Error).message);
  }
});

// ───────────────────────── arranque

cambiarVista('por_revisar');
const guardado = pinAdmin.get();
if (guardado) {
  api
    .adminEntrar(guardado)
    .then((ok) => (ok ? entrar(guardado) : salir()))
    .catch(() => salir());
} else {
  salir();
}
