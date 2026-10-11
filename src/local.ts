// localStorage con try/catch (modo privado, almacenamiento bloqueado): la app funciona sin él.

import { uuid } from './api';

const PREFIJO = 'chelas.';

function leer(clave: string): string | null {
  try {
    return localStorage.getItem(PREFIJO + clave);
  } catch {
    return null;
  }
}

function guardar(clave: string, valor: string | null): void {
  try {
    if (valor === null) localStorage.removeItem(PREFIJO + clave);
    else localStorage.setItem(PREFIJO + clave, valor);
  } catch {
    /* sin almacenamiento: se olvida al cerrar */
  }
}

let secretoEnMemoria: string | null = null;

/** Secreto del dispositivo: firma las fotos propias para poder borrarlas. Nunca sale de aquí más que a las RPC. */
export function secreto(): string {
  if (secretoEnMemoria) return secretoEnMemoria;
  let s = leer('secreto');
  if (!s || s.length < 20) {
    s = `${uuid()}${uuid()}`.replace(/-/g, '');
    guardar('secreto', s);
  }
  secretoEnMemoria = s;
  return s;
}

/** sha256 hex del secreto: así la base marca el autor de cada foto (columna autor). */
export async function miAutor(): Promise<string> {
  const datos = new TextEncoder().encode(secreto());
  const hash = await crypto.subtle.digest('SHA-256', datos);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Copia local del perfil (la base manda; se refresca al abrir la app). */
export interface PerfilLocal {
  nombre: string;
  telefono: string | null;
  acepta_promos: boolean;
}

export const perfil = {
  get: (): PerfilLocal | null => {
    try {
      const p = JSON.parse(leer('perfil') ?? 'null') as PerfilLocal | null;
      return p && typeof p.nombre === 'string' && p.nombre ? p : null;
    } catch {
      return null;
    }
  },
  set: (p: PerfilLocal | null): void => guardar('perfil', p ? JSON.stringify(p) : null),
};

/** Cuándo se abrió sola la guía de instalación por última vez (ms): una vez por semana. */
export const instalarVisto = {
  get: (): number => Number(leer('instalar-visto') ?? 0) || 0,
  set: (): void => guardar('instalar-visto', String(Date.now())),
};

/** Cuándo se cerró la tarjeta "Instala la app" (ms). */
export const instalarCerrado = {
  get: (): number => Number(leer('instalar-cerrado') ?? 0) || 0,
  set: (): void => guardar('instalar-cerrado', String(Date.now())),
};

export const pinAdmin = {
  get: (): string => leer('pin') ?? '',
  set: (v: string | null): void => guardar('pin', v),
};

export const ultimoTamano = {
  get: (): string => leer('tamano') ?? '',
  set: (v: string): void => guardar('tamano', v),
};
