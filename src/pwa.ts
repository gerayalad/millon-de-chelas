// PWA: service worker, guía para instalar en la pantalla de inicio (según dispositivo y
// navegador) y avisos push de metas. En iPhone los avisos solo funcionan con la app instalada
// (iOS 16.4+) y abierta desde su ícono, por eso la guía y los avisos van de la mano.
// Si no está instalada: botón "Instalar" arriba, tarjeta en la portada y, una vez por semana,
// la guía se abre sola.

import * as api from './api';
import { instalarCerrado, instalarVisto, secreto } from './local';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

type Plataforma = 'iphone' | 'android' | 'compu';
type Navegador =
  | 'ios-safari'
  | 'ios-chrome'
  | 'ios-app'
  | 'android-chrome'
  | 'android-samsung'
  | 'android-app'
  | 'compu-chrome'
  | 'compu-safari'
  | 'compu-otro';

interface EventoInstalar extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const SEMANA = 7 * 86_400_000;

const ua = navigator.userAgent;
const esIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
const esAndroid = /Android/.test(ua);
/** Navegador dentro de otra app (Facebook, Instagram, WebView): ahí no se puede instalar. */
const enOtraApp = /FBAN|FBAV|Instagram|Line\/|Twitter|; wv\)/.test(ua);

/** Detectado al cargar: desde su ícono (standalone) o, en Android, instalada aunque abran el navegador. */
let yaInstalada = false;

export function instalada(): boolean {
  return (
    yaInstalada ||
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function detectar(): Navegador {
  if (esIOS) {
    if (enOtraApp) return 'ios-app';
    if (/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)) return 'ios-chrome';
    return 'ios-safari';
  }
  if (esAndroid) {
    if (enOtraApp) return 'android-app';
    if (/SamsungBrowser/.test(ua)) return 'android-samsung';
    return 'android-chrome';
  }
  if (/Edg\/|Chrome\//.test(ua)) return 'compu-chrome';
  if (/Safari\//.test(ua) && /Macintosh/.test(ua)) return 'compu-safari';
  return 'compu-otro';
}

function avisosSoportados(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

let eventoInstalar: EventoInstalar | null = null;
let toast: (t: string, ms?: number) => void = () => undefined;

// ───────────────────────── guía de instalación (contenido fijo: se puede usar innerHTML)

const T = (s: string): string => `<span class="tecla">${s}</span>`;

const GUIAS: Record<Navegador, { plataforma: Plataforma; nombre: string; detectado: string; pasos: string[] }> = {
  'ios-safari': {
    plataforma: 'iphone',
    nombre: 'Safari',
    detectado: 'iPhone con Safari',
    pasos: [
      `Toca <b>Compartir</b> ${T('⬆︎')} en la barra de abajo (en iPad, arriba).`,
      'Desliza hacia abajo y toca <b>Agregar a inicio</b>.',
      'Toca <b>Agregar</b> (arriba a la derecha).',
      'Abre la app desde el ícono 🍺 en tu pantalla de inicio.',
    ],
  },
  'ios-chrome': {
    plataforma: 'iphone',
    nombre: 'Chrome',
    detectado: 'iPhone con Chrome',
    pasos: [
      `Toca <b>Compartir</b> ${T('⬆︎')} a la derecha de la barra de direcciones.`,
      'Toca <b>Agregar a pantalla de inicio</b> (si no lo ves, toca <b>Ver más</b>).',
      'Toca <b>Agregar</b> y ábrela desde el ícono 🍺.',
      'Si no te sale la opción (iOS viejito), abre <b>chela.happytohelp.mx</b> en Safari.',
    ],
  },
  'ios-app': {
    plataforma: 'iphone',
    nombre: 'Desde otra app',
    detectado: 'iPhone, dentro de otra app (Instagram, Facebook…)',
    pasos: [
      `Toca ${T('⋯')} (arriba o abajo) y elige <b>Abrir en Safari</b> o <b>Abrir en el navegador</b>.`,
      `Ya en Safari: <b>Compartir</b> ${T('⬆︎')} → <b>Agregar a inicio</b>.`,
      'Toca <b>Agregar</b> y ábrela desde el ícono 🍺.',
    ],
  },
  'android-chrome': {
    plataforma: 'android',
    nombre: 'Chrome',
    detectado: 'Android con Chrome',
    pasos: [
      `Toca el menú ${T('⋮')} arriba a la derecha.`,
      'Toca <b>Instalar app</b> (o <b>Agregar a la pantalla principal</b>).',
      'Confirma con <b>Instalar</b>. Queda junto a tus apps 🍺.',
      `¿La abriste desde WhatsApp? Primero ${T('⋮')} → <b>Abrir en Chrome</b>.`,
    ],
  },
  'android-samsung': {
    plataforma: 'android',
    nombre: 'Samsung Internet',
    detectado: 'Android con Samsung Internet',
    pasos: [
      `Toca el menú ${T('≡')} abajo a la derecha.`,
      'Toca <b>Agregar página a</b> → <b>Pantalla de inicio</b>.',
      'Toca <b>Agregar</b>. Queda junto a tus apps 🍺.',
    ],
  },
  'android-app': {
    plataforma: 'android',
    nombre: 'Desde otra app',
    detectado: 'Android, dentro de otra app (Instagram, Facebook…)',
    pasos: [
      `Toca ${T('⋮')} arriba a la derecha y elige <b>Abrir en Chrome</b> (o <b>Abrir en el navegador</b>).`,
      `Ya en Chrome: ${T('⋮')} → <b>Instalar app</b>.`,
      'Confirma con <b>Instalar</b>.',
    ],
  },
  'compu-chrome': {
    plataforma: 'compu',
    nombre: 'Chrome / Edge',
    detectado: 'compu con Chrome o Edge',
    pasos: [
      `Haz clic en el ícono de instalar ${T('⊕')} al final de la barra de direcciones.`,
      'Haz clic en <b>Instalar</b>.',
      `¿No ves el ícono? Chrome: ${T('⋮')} → <b>Transmitir, guardar y compartir</b> → <b>Instalar página como app</b>. Edge: ${T('⋯')} → <b>Aplicaciones</b> → <b>Instalar este sitio como aplicación</b>.`,
    ],
  },
  'compu-safari': {
    plataforma: 'compu',
    nombre: 'Safari (Mac)',
    detectado: 'Mac con Safari',
    pasos: ['Menú <b>Archivo</b> → <b>Agregar al Dock</b> (macOS Sonoma o más nuevo).', 'Haz clic en <b>Agregar</b>.'],
  },
  'compu-otro': {
    plataforma: 'compu',
    nombre: 'Otro',
    detectado: 'un navegador que no instala apps',
    pasos: ['Este navegador no instala apps web.', 'Abre <b>chela.happytohelp.mx</b> en <b>Chrome</b> o <b>Edge</b> y sigue esos pasos.'],
  },
};

const DEFECTO: Record<Plataforma, Navegador> = { iphone: 'ios-safari', android: 'android-chrome', compu: 'compu-chrome' };
const NOTA: Record<Plataforma, string> = {
  iphone: 'En iPhone, los avisos de metas solo llegan con la app instalada y abierta desde su ícono.',
  android: 'También funciona con Edge u Opera: busca “Instalar app” en su menú.',
  compu: '',
};

const detectado = detectar();

function pintarGuia(nav: Navegador): void {
  const g = GUIAS[nav];
  document
    .querySelectorAll<HTMLButtonElement>('[data-plataforma]')
    .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset['plataforma'] === g.plataforma)));
  const chips = $('guia-navegadores');
  chips.replaceChildren(
    ...(Object.keys(GUIAS) as Navegador[])
      .filter((n) => GUIAS[n].plataforma === g.plataforma)
      .map((n) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip-nav';
        b.textContent = GUIAS[n].nombre;
        b.setAttribute('aria-pressed', String(n === nav));
        b.addEventListener('click', () => pintarGuia(n));
        return b;
      }),
  );
  $('guia-pasos').innerHTML = g.pasos.map((p) => `<li>${p}</li>`).join('');
  $('guia-nota').textContent = NOTA[g.plataforma];
  $('guia-nota').hidden = !NOTA[g.plataforma];
}

export function abrirGuia(): void {
  const dlg = $<HTMLDialogElement>('dlg-instalar');
  $('guia-detectado').textContent = instalada() ? '✓ Ya la tienes instalada.' : `Detectamos: ${GUIAS[detectado].detectado}`;
  pintarGuia(detectado);
  $('instalar-ya').hidden = !eventoInstalar;
  if (!dlg.open) dlg.showModal();
}

document.querySelectorAll<HTMLButtonElement>('[data-plataforma]').forEach((b) => {
  b.addEventListener('click', () => {
    const p = b.dataset['plataforma'] as Plataforma;
    pintarGuia(GUIAS[detectado].plataforma === p ? detectado : DEFECTO[p]);
  });
});

async function instalarYa(): Promise<void> {
  if (!eventoInstalar) return abrirGuia();
  await eventoInstalar.prompt();
  const { outcome } = await eventoInstalar.userChoice;
  eventoInstalar = null;
  $('instalar-ya').hidden = true;
  if (outcome === 'accepted') {
    toast('¡Listo! Ya la tienes como app 🍺');
    $<HTMLDialogElement>('dlg-instalar').close();
    pintarInstalar();
  }
}

/** Una vez por semana, si no está instalada, la guía se abre sola (sin encimarse a otra hoja). */
function recordatorioSemanal(): void {
  if (instalada() || Date.now() - instalarVisto.get() < SEMANA) return;
  let intentos = 0;
  const probar = (): void => {
    if (instalada()) return;
    if ([...document.querySelectorAll('dialog')].some((d) => d.open)) {
      if (++intentos < 12) window.setTimeout(probar, 5000);
      return;
    }
    instalarVisto.set();
    abrirGuia();
  };
  window.setTimeout(probar, 4000);
}

// ───────────────────────── avisos de metas

function llaveAplicacion(): Uint8Array<ArrayBuffer> {
  const b64 = import.meta.env.VITE_VAPID_PUBLIC.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function suscripcion(): Promise<PushSubscription | null> {
  if (!avisosSoportados()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export type EstadoAvisos = 'activos' | 'apagados' | 'bloqueados' | 'instalar-primero' | 'sin-soporte';

export async function estadoAvisos(): Promise<EstadoAvisos> {
  if (!avisosSoportados()) return esIOS && !instalada() ? 'instalar-primero' : 'sin-soporte';
  if (Notification.permission === 'denied') return 'bloqueados';
  return (await suscripcion()) ? 'activos' : 'apagados';
}

/** Pide permiso y suscribe (debe llamarse desde un toque del usuario). */
export async function activarAvisos(): Promise<boolean> {
  if (!avisosSoportados()) return false;
  const permiso = await Notification.requestPermission();
  if (permiso !== 'granted') return false;
  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: llaveAplicacion() }));
  await api.guardarSuscripcion(secreto(), sub.toJSON());
  return true;
}

export async function desactivarAvisos(): Promise<void> {
  const sub = await suscripcion();
  if (!sub) return;
  await api.borrarSuscripcion(sub.endpoint).catch(() => undefined);
  await sub.unsubscribe();
}

export async function pintarAvisos(): Promise<void> {
  const boton = $<HTMLButtonElement>('avisos-boton');
  const nota = $('avisos-nota');
  const estado = await estadoAvisos();
  boton.hidden = estado === 'sin-soporte' || estado === 'bloqueados';
  boton.disabled = false;
  boton.dataset['estado'] = estado;
  boton.textContent = { activos: 'Desactivar', apagados: 'Activar', 'instalar-primero': 'Cómo instalar', bloqueados: '', 'sin-soporte': '' }[estado];
  $('avisos-estado').textContent =
    estado === 'activos' ? '✓ Te avisamos en cada millar.' : 'Te avisamos cuando el grupo llegue a cada millar (10,000, 11,000…).';
  nota.textContent = {
    activos: '',
    apagados: '',
    'instalar-primero': 'En iPhone los avisos llegan con la app instalada: agrégala a tu inicio y ábrela desde su ícono.',
    bloqueados: 'Bloqueaste los avisos para esta página. Actívalos en los ajustes del navegador.',
    'sin-soporte': 'Este navegador no soporta avisos. Prueba con Chrome, Safari (app instalada) o Edge.',
  }[estado];
}

async function tocarAvisos(): Promise<void> {
  const boton = $<HTMLButtonElement>('avisos-boton');
  const estado = boton.dataset['estado'] as EstadoAvisos;
  if (estado === 'instalar-primero') return abrirGuia();
  boton.disabled = true;
  try {
    if (estado === 'activos') {
      await desactivarAvisos();
      toast('Avisos desactivados');
    } else if (await activarAvisos()) {
      toast('🔔 ¡Listo! Te avisamos en la siguiente meta');
    } else {
      toast('No se activaron los avisos (permiso no concedido).');
    }
  } catch (e) {
    toast((e as Error).message || 'No se pudieron activar los avisos.');
  }
  await pintarAvisos();
  void pintarTarjeta();
}

// ───────────────────────── botón de arriba y tarjeta en la portada

function pintarInstalar(): void {
  $('instalar-top').hidden = instalada();
  void pintarTarjeta();
}

async function pintarTarjeta(): Promise<void> {
  const tarjeta = $('instalar-card');
  if (Date.now() - instalarCerrado.get() < SEMANA) {
    tarjeta.hidden = true;
    return;
  }
  if (!instalada()) {
    tarjeta.dataset['modo'] = 'instalar';
    $('instalar-titulo').textContent = 'Llévala en tu pantalla de inicio';
    $('instalar-texto').textContent = 'Ábrela como app y entérate cuando el grupo llegue a cada meta.';
    $('instalar-abrir').textContent = 'Instalar';
    tarjeta.hidden = false;
    return;
  }
  const estado = await estadoAvisos();
  tarjeta.dataset['modo'] = 'avisos';
  $('instalar-titulo').textContent = '¿Te avisamos de las metas?';
  $('instalar-texto').textContent = 'Una notificación cada 1,000 chelas. Nada más.';
  $('instalar-abrir').textContent = 'Activar';
  tarjeta.hidden = estado !== 'apagados';
}

/** Android/Chrome: ¿ya está instalada aunque la abran en el navegador? (related_applications del manifest). */
async function revisarInstalada(): Promise<void> {
  const nav = navigator as Navigator & { getInstalledRelatedApps?: () => Promise<unknown[]> };
  try {
    if (nav.getInstalledRelatedApps && (await nav.getInstalledRelatedApps()).length > 0) yaInstalada = true;
  } catch {
    /* no soportado */
  }
}

export function iniciarPWA(opciones: { toast: (t: string, ms?: number) => void }): void {
  toast = opciones.toast;
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js').catch(() => undefined));
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    eventoInstalar = e as EventoInstalar;
    $('instalar-ya').hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    eventoInstalar = null;
    yaInstalada = true;
    pintarInstalar();
  });

  $('instalar-ya').addEventListener('click', () => void instalarYa());
  $('instalar-top').addEventListener('click', () => (eventoInstalar ? void instalarYa() : abrirGuia()));
  $('abrir-guia').addEventListener('click', abrirGuia);
  $('avisos-boton').addEventListener('click', () => void tocarAvisos());
  $('instalar-abrir').addEventListener('click', () => {
    if ($('instalar-card').dataset['modo'] === 'avisos') void tocarAvisos();
    else if (eventoInstalar) void instalarYa();
    else abrirGuia();
  });
  $('instalar-cerrar').addEventListener('click', () => {
    instalarCerrado.set();
    $('instalar-card').hidden = true;
  });

  pintarInstalar();
  void revisarInstalada().then(() => {
    pintarInstalar();
    recordatorioSemanal();
  });
}
