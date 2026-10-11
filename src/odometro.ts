// Contador tipo odómetro (como el de los pétalos del xolo): cada cifra es una tira 0-9 que
// rueda hasta su lugar. Si cambia el número de cifras se rearma, partiendo de las anteriores.

const NUM = new Intl.NumberFormat('es-MX');

export function formato(n: number): string {
  return NUM.format(Math.max(0, Math.floor(n)));
}

export class Odometro {
  private readonly raiz: HTMLElement;
  private texto = '';
  private tiras: HTMLElement[] = [];

  constructor(raiz: HTMLElement) {
    this.raiz = raiz;
  }

  set(n: number, animar = true): void {
    const nuevo = formato(n);
    if (nuevo === this.texto) return;
    this.raiz.setAttribute('aria-label', nuevo);

    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const conAnimacion = animar && !reduce && this.texto !== '';

    if (nuevo.length !== this.texto.length) {
      // Cifras anteriores alineadas a la derecha (las nuevas a la izquierda arrancan en 0).
      const viejas = this.texto.replace(/\D/g, '');
      const cifras = nuevo.replace(/\D/g, '');
      const previas = viejas.padStart(cifras.length, '0').slice(-cifras.length);
      this.armar(nuevo, conAnimacion ? previas : cifras);
      if (conAnimacion) void this.raiz.offsetWidth;
    }
    this.texto = nuevo;
    const cifras = nuevo.replace(/\D/g, '');
    this.tiras.forEach((tira, i) => {
      tira.classList.toggle('sin-animacion', !conAnimacion);
      tira.style.transform = `translateY(${-Number(cifras[i])}em)`;
    });
  }

  private armar(texto: string, iniciales: string): void {
    this.raiz.textContent = '';
    this.tiras = [];
    let i = 0;
    for (const c of texto) {
      if (/\d/.test(c)) {
        const celda = document.createElement('span');
        celda.className = 'odo-cifra';
        celda.setAttribute('aria-hidden', 'true');
        const tira = document.createElement('span');
        tira.className = 'odo-tira sin-animacion';
        tira.textContent = '0\n1\n2\n3\n4\n5\n6\n7\n8\n9';
        tira.style.transform = `translateY(${-Number(iniciales[i] ?? 0)}em)`;
        celda.append(tira);
        this.raiz.append(celda);
        this.tiras.push(tira);
        i++;
      } else {
        const sep = document.createElement('span');
        sep.className = 'odo-sep';
        sep.setAttribute('aria-hidden', 'true');
        sep.textContent = c;
        this.raiz.append(sep);
      }
    }
  }
}
