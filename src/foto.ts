// Fotos en el cliente: se comprimen antes de subir (foto de 1080 px para el detalle y
// miniatura de 640 px para el álbum y la IA, JPEG; ~120 KB + ~40 KB) y se arma la tarjeta para
// mandar al grupo (la foto con el número de chela encima, 1080×1350). Por eso no hace falta la
// transformación de imágenes de Supabase (se cobra por imagen).

export const FOTO = { lado: 1080, calidad: 0.78 };
export const MINI = { lado: 640, calidad: 0.75 };

function cargarImagen(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('imagen'));
    img.src = url;
  });
}

function aBlob(canvas: HTMLCanvasElement, calidad: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas'))), 'image/jpeg', calidad);
  });
}

/** El navegador ya aplica la orientación EXIF al dibujar un <img>; aquí solo se escala. */
export async function comprimir(archivo: Blob, { lado, calidad } = FOTO): Promise<Blob> {
  const url = URL.createObjectURL(archivo);
  try {
    const img = await cargarImagen(url);
    const escala = Math.min(1, lado / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * escala));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * escala));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await aBlob(canvas, calidad);
  } finally {
    URL.revokeObjectURL(url);
  }
}

const FUENTE = '"Bricolage Grotesque", system-ui, sans-serif';

async function fuenteLista(): Promise<void> {
  try {
    await Promise.race([
      document.fonts.load(`800 200px ${FUENTE}`),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
  } catch {
    /* sin la fuente se usa la del sistema */
  }
}

export interface DatosTarjeta {
  numero: string;
  meta: string;
  pie: string;
}

/** Tarjeta 1080×1350: la foto recortada a 4:5 con el número de chela abajo. */
export async function tarjeta(foto: Blob, datos: DatosTarjeta): Promise<Blob> {
  const W = 1080;
  const H = 1350;
  const url = URL.createObjectURL(foto);
  try {
    const [img] = await Promise.all([cargarImagen(url), fuenteLista()]);
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas');

    // Foto en modo "cover".
    const escala = Math.max(W / img.naturalWidth, H / img.naturalHeight);
    const w = img.naturalWidth * escala;
    const h = img.naturalHeight * escala;
    ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);

    // Degradado inferior para que el número se lea sobre cualquier foto.
    const g = ctx.createLinearGradient(0, H * 0.5, 0, H);
    g.addColorStop(0, 'rgba(20, 12, 5, 0)');
    g.addColorStop(0.55, 'rgba(20, 12, 5, 0.72)');
    g.addColorStop(1, 'rgba(20, 12, 5, 0.94)');
    ctx.fillStyle = g;
    ctx.fillRect(0, H * 0.5, W, H * 0.5);

    const x = 72;
    ctx.textBaseline = 'alphabetic';

    ctx.fillStyle = 'rgba(255, 246, 227, 0.85)';
    ctx.font = `600 42px ${FUENTE}`;
    ctx.fillText('🍺 MILLÓN DE CHELAS', x, H - 330);

    // Número grande; se encoge si no cabe.
    let tam = 240;
    ctx.font = `800 ${tam}px ${FUENTE}`;
    while (ctx.measureText(datos.numero).width > W - x * 2 && tam > 120) {
      tam -= 10;
      ctx.font = `800 ${tam}px ${FUENTE}`;
    }
    ctx.fillStyle = '#ffc54d';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = 24;
    ctx.fillText(datos.numero, x - 6, H - 120);
    ctx.shadowBlur = 0;

    ctx.fillStyle = 'rgba(255, 246, 227, 0.92)';
    const linea = `${datos.meta} · ${datos.pie}`;
    let chica = 40;
    ctx.font = `600 ${chica}px ${FUENTE}`;
    while (ctx.measureText(linea).width > W - x * 2 && chica > 24) {
      chica -= 2;
      ctx.font = `600 ${chica}px ${FUENTE}`;
    }
    ctx.fillText(linea, x, H - 62);

    return await aBlob(canvas, 0.9);
  } finally {
    URL.revokeObjectURL(url);
  }
}
