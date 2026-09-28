// Prueba manual de la lista de salas, sin la app. Se ejecuta:
//   node tools/servidor/probar-lista.js
// Levanta relay.js, mete un anfitrion y un invitado, y pide la lista.
//
// Existe porque la app no se puede easily depurar en el movil: si la lista sale
// vacia, hay que saber si es el servidor o el cliente, y esto responde a esa
// pregunta sin telefono.

'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const net = require('net');
const path = require('path');

/**
 * Un puerto libre de verdad.
 *
 * Antes se elegia a mano en el rango 8080-8120 y|resultaba que hay un programa
 * de Windows escuchando en el 8090 (WsToastNotification): el servidor de Node
 * no podia abrirlo, se caia al arrancar, y la prueba decia "el servidor no
 * contesto a la lista" cuando el problema era que no hubo servidor. Se pide
 * uno al sistema y se le pasa a Node con PORT.
 */
function puertoLibre() {
  return new Promise((cumplir, fallar) => {
    const s = net.createServer();
    s.on('error', fallar);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => cumplir(p));
    });
  });
}

function texto(s) {
  const b = Buffer.from(s, 'utf8');
  const r = Buffer.alloc(4 + b.length);
  r.writeUInt32BE(b.length, 0);
  b.copy(r, 4);
  return r;
}

/**
 * Espera un poco a que el servidor este listo.
 *
 * El handshake y la primera trama pueden llegar en el mismo paquete. Si se
 * manda LISTAR en cuanto termina el handshake, hay casos en que los bytes entran
 * en el mismo manejador que la peticion HTTP y se procesan antes de que el
 * servidor haya montado su manejador de trama: se pierden y no hay respuesta.
 * Un margen pequeño lo evita, y es justo lo que hace un cliente de verdad
 * esperando al `open` del socket.
 */
function respira(ms) {
  return new Promise((c) => setTimeout(c, ms));
}

function mensaje(tipo, cuerpo) {
  const m = Buffer.alloc(5 + cuerpo.length);
  m[0] = tipo;
  m.writeInt32BE(cuerpo.length, 1);
  cuerpo.copy(m, 5);
  return m;
}

function trama(m, conMascara) {
  const largo = m.length;
  let cab;
  if (largo < 126) {
    cab = Buffer.alloc(2);
    cab[1] = largo;
  } else {
    cab = Buffer.alloc(4);
    cab[1] = 126;
    cab.writeUInt16BE(largo, 2);
  }
  cab[0] = 0x81;
  if (!conMascara) return Buffer.concat([cab, m]);
  const mascara = crypto.randomBytes(4);
  cab[1] |= 0x80;
  const d = Buffer.from(m);
  for (let i = 0; i < d.length; i++) d[i] ^= mascara[i % 4];
  return Buffer.concat([cab, mascara, d]);
}

/** Un cliente WebSocket a mano, como el de la app. */
class Cliente {
  constructor() {
    this.cola = [];
    // Los bytes que llegan por red y todavia no son una trama entera. Se
    // acumulan aqui porque un paquete puede traer media trama, o varias.
    this.entrada = Buffer.alloc(0);
    this.sello = crypto.randomBytes(16).toString('base64');
  }

  conecta(puerto) {
    return new Promise((cumplir, fallar) => {
      this.socket = net.connect(puerto, '127.0.0.1', () => {
        const p =
          `GET / HTTP/1.1\r\nHost: 127.0.0.1:${puerto}\r\n` +
          `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${this.sello}\r\nSec-WebSocket-Version: 13\r\n\r\n`;
        this.socket.write(Buffer.from(p, 'ascii'));
      });
      let cabecera = true;
      this.socket.on('data', (d) => {
        this.entrada = Buffer.concat([this.entrada, d]);
        if (cabecera) {
          const fin = this.entrada.indexOf('\r\n\r\n');
          if (fin < 0) return;
          cabecera = false;
          // Lo que va detras de la cabecera se queda en el buffer para las
          // tramas. Antes se guardaba en otra variable y se perdia, y por eso
          // esta prueba decia que el servidor no contestaba a la lista cuando si
          // que habia contestado.
          this.entrada = this.entrada.slice(fin + 4);
          this.selloEsperado = crypto.createHash('sha1')
            .update(this.sello + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
            .digest('base64');
          //Primero se leen las tramas que vengan detras de la cabecera, y
          //despues se avisa de que ya se puede hablar. Si se avisara antes, la
          //espera del otro lado podria empezar a mirar la cola antes de que
          //estuviera llena, y perder el primer mensaje.
          this.leeTramas();
          cumplir();
          return;
        }
        this.leeTramas();
      });
      this.socket.on('error', fallar);
    });
  }

  leeTramas() {
    for (;;) {
      const b = this.entrada;
      if (b.length < 2) return;
      let largo = b[1] & 0x7f;
      let pos = 2;
      if (largo === 126) {
        if (b.length < 4) return;
        largo = b.readUInt16BE(2);
        pos = 4;
      }
      const carga = b.slice(pos, pos + largo);
      if (carga.length < largo) return;      // trama a medias: esperar mas
      this.entrada = b.slice(pos + largo);
      // La carga de la trama es el mensaje entero del juego: 1 byte de tipo +
      // 4 de largo + cuerpo. Se guarda **entero**, sin quitar nada, porque quien
      // lo lee necesita el tipo del primer byte y el cuerpo a partir del
      // quinto. Quitar la cabecera aqui obligaba a reconstruirla luego y
      // acababa leyendo el largo en vez del numero de salas.
      this.cola.push(carga);
    }
  }

  envia(tipo, cuerpo) {
    const m = mensaje(tipo, cuerpo);
    if (process.env.LISTA_DEBUG) {
      console.log(`    -> envia tipo ${tipo}, mensaje ${m.join(',')}, trama ${trama(m, true).join(',')}`);
    }
    this.socket.write(trama(m, true));
  }

  siguiente() {
    const m = this.cola.length ? this.cola.shift() : null;
    if (process.env.LISTA_DEBUG && m) console.log(`    (cola: ${m.join(',')})`);
    return m;
  }

  /** Espera un mensaje de un tipo concreto. */
  esperaTipo(tipo, ms) {
    const limite = Date.now() + ms;
    return new Promise((cumplir) => {
      const mirar = () => {
        const m = this.siguiente();
        if (m !== null) {
          if (process.env.LISTA_DEBUG) {
            console.log(`    <- tipo ${m[0]}: ${JSON.stringify(m.toString('utf8'))}`);
          }
          if (m[0] === tipo) return cumplir(m);
          if (m[0] === 10) {
            // Un ERROR con texto legible es muchisimo mas util que "el
            // servidor no contesto". Por eso el servidor manda el motivo en
            // vez de callarse, y por eso aqui se enseña.
            const largo = m.readUInt32BE(1);
            return cumplir(new Error(`el servidor dijo: ${m.slice(5, 5 + largo).toString('utf8')}`));
          }
          return mirar();
        }
        if (Date.now() > limite) return cumplir(null);
        setTimeout(mirar, 25);
      };
      mirar();
    });
  }

  cierra() {
    try { this.socket.destroy(); } catch (e) { }
  }
}

function leeTexto(buf, desde) {
  const largo = buf.readUInt32BE(desde);
  return {
    texto: buf.slice(desde + 4, desde + 4 + largo).toString('utf8'),
    pos: desde + 4 + largo,
  };
}

function esperaRespuesta(puerto) {
  return new Promise((cumplir, fallar) => {
    // Se comprueba que el puerto escucha de verdad, pero **sin** usar http: la
    // peticion de comprobacion y la primera conexion del WebSocket tienen que
    // llegar por separado, porque si se juntan, el servidor responde al http y
    // monta el manejador de trama tarde, y el primer LISTAR se queda sin
    // contestacion.
    const s = net.connect(puerto, '127.0.0.1', () => {
      s.destroy();
      cumplir();
    });
    s.on('error', fallar);
  });
}

async function main() {
  const PUERTO = await puertoLibre();
  const servidor = spawn('node', [path.join(__dirname, 'relay.js')], {
    env: { ...process.env, PORT: String(PUERTO) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servidor.stdout.on('data', (d) => process.stdout.write('    [servidor] ' + d));
  servidor.stderr.on('data', (d) => process.stdout.write('    [servidor!] ' + d));

  try {
    // Se espera a que responda, no a un tiempo fijo.
    const limite = Date.now() + 15000;
    for (;;) {
      try { await esperaRespuesta(PUERTO); break; } catch (e) {
        if (Date.now() > limite) throw new Error('el servidor no arranco');
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    console.log(`  ok   el servidor arranco en el puerto ${PUERTO}`);

    // 1. Nadie dentro: no hay nada.
    const miron = new Cliente();
    await miron.conecta(PUERTO);
    await respira(250);
    miron.envia(12, Buffer.alloc(0));
    const vacia = await miron.esperaTipo(13, 5000);
    if (!vacia) throw new Error('el servidor no contesto a la lista');
    if (vacia instanceof Error) throw vacia;
    console.log(`  ok   sin jugadores salen ${vacia.readInt32BE(6)} salas`);
    miron.cierra();

    // 2. Anfitrion solo: tampoco sale, porque nadie puede entrar.
    const a = new Cliente();
    await a.conecta(PUERTO);
    const hol = Buffer.concat([
      Buffer.from([1, 1]),
      texto('314159'), texto('Marcelo'), texto('BLANCO'), texto('Sala de prueba'),
    ]);
    a.envia(1, hol);
    a.envia(14, Buffer.concat([
      Buffer.from([1, 2, 1]),
      (() => { const b = Buffer.alloc(4); b.writeInt32BE(300, 0); return b; })(),
      (() => { const b = Buffer.alloc(4); b.writeInt32BE(1000, 0); return b; })(),
      texto('Sala de prueba'),
    ]));
    await new Promise((r) => setTimeout(r, 400));
    const solo = new Cliente();
    await solo.conecta(PUERTO);
    solo.envia(12, Buffer.alloc(0));
    const sinRival = await solo.esperaTipo(13, 5000);
    const nSinRival = sinRival.readInt32BE(6);
    // Una sala a la que le falta un jugador **si** tiene que salir en la lista:
    // es justo para eso. Para entrar por la lista hace falta ver las que estan
    // esperando. Antes solo se publicaban las llenas, y eso hacia la lista
    // inútil: una sala solo se publicaba cuando ya tenia a los dos dentro, que
    // es cuando nadie la necesita.
    if (nSinRival !== 1) {
      throw new Error(`una sala a la que le falta uno tiene que salir; salen ${nSinRival}`);
    }
    console.log('  ok   una sala a medio llenar sale en la lista');
    // Y tiene que decir que le falta uno, para que se sepa que se puede entrar.
    {
      let p = 10;
      p += 4 + sinRival.readUInt32BE(p);
      p += 4 + sinRival.readUInt32BE(p);
      p += 2;                              // mapa y noche
      p += 4 + 4;                         // duracion y amor
      const cuantos = sinRival.readInt32BE(p);
      if (cuantos !== 1) {
        throw new Error(`tiene que decir que le falta uno; dice ${cuantos}`);
      }
      console.log('  ok   y avisa de que le falta un jugador');
    }
    solo.cierra();

    // 3. Entra el invitado: ahora sale, con nombre y reglas.
    const b = new Cliente();
    await b.conecta(PUERTO);
    b.envia(1, Buffer.concat([
      Buffer.from([1, 0]),
      texto('314159'), texto('Ana'), texto('MARRON'), texto(''),
    ]));
    const ready = await a.esperaTipo(3, 6000);
    if (!ready) throw new Error('el anfitrion no recibio READY');
    console.log('  ok   los dos dentro');

    const lista = new Cliente();
    await lista.conecta(PUERTO);
    lista.envia(12, Buffer.alloc(0));
    const conRival = await lista.esperaTipo(13, 6000);
    if (!conRival) throw new Error('el servidor no contesto a la lista');
    // El mensaje es: [0]=tipo, [1..4]=largo, [5]=version, [6..9]=cuantas salas,
// y a partir del 10 empieza la primera. Los indices raros son porque aqui se
// lee el mensaje entero, con su cabecera, y no el cuerpo suelto.
const cuantas = conRival.readInt32BE(6);
    if (cuantas !== 1) throw new Error(`deberia salir 1 sala, salen ${cuantas}`);
    let pos = 10;
    const codigo = leeTexto(conRival, pos); pos = codigo.pos;
    const nombre = leeTexto(conRival, pos); pos = nombre.pos;
    const mapa = conRival[pos]; pos += 1;
    const noche = conRival[pos]; pos += 1;
    const dur = conRival.readInt32BE(pos); pos += 4;
    const amor = conRival.readInt32BE(pos); pos += 4;
    console.log(`  ok   sale la sala ${codigo.texto} "${nombre.texto}" ` +
      `mapa ${mapa}${noche ? ' noche' : ''} ${dur}s hasta ${amor} de amor`);

    if (codigo.texto !== '314159') throw new Error('el codigo no cuadra');
    if (nombre.texto !== 'Sala de prueba') throw new Error('el nombre no cuadra');
    if (mapa !== 2) throw new Error('el mapa no cuadra');
    if (noche !== 1) throw new Error('la noche no cuadra');
    if (dur !== 300) throw new Error('la duracion no cuadra');
    if (amor !== 1000) throw new Error('el limite de amor no cuadra');

    // 4. Al irse el invitado, la sala sigue pero pasando a "le falta uno", y
    //    cuando se va el otro tambien, ya no sale.
    //
    //    Antes se comprobaba que la sala desaparecia de golpe. Con la regla
    //    nueva (publicar tambien las medias) eso ya no es lo que tiene que
    //    pasar: una sala con el anfitrion solo **debe** seguir en la lista,
    //    porque es una sala a la que se puede entrar.
    b.cierra();
    await new Promise((r) => setTimeout(r, 600));
    const despues = new Cliente();
    await despues.conecta(PUERTO);
    despues.envia(12, Buffer.alloc(0));
    const trasSalir = await despues.esperaTipo(13, 5000);
    const nTras = trasSalir.readInt32BE(6);
    if (nTras !== 1) {
      throw new Error(`tras irse uno deberia quedar la sala a medio llenar; salen ${nTras}`);
    }
    console.log('  ok   al irse uno, la sala queda a medio llenar y se puede entrar');

    // Ahora se va el anfitrion: ya no hay nadie, y la sala desaparece.
    a.cierra();
    await new Promise((r) => setTimeout(r, 600));
    const ultimo = new Cliente();
    await ultimo.conecta(PUERTO);
    ultimo.envia(12, Buffer.alloc(0));
    const sinNadie = await ultimo.esperaTipo(13, 5000);
    const nSinNadie = sinNadie.readInt32BE(6);
    if (nSinNadie !== 0) {
      throw new Error(`sin nadie dentro no deberia quedar ninguna sala; quedan ${nSinNadie}`);
    }
    console.log('  ok   sin nadie dentro, la sala desaparece');
    ultimo.cierra();

    a.cierra();
    lista.cierra();
    despues.cierra();

    console.log('\n  TODO BIEN\n');
  } finally {
    servidor.kill();
  }
}

main().catch((e) => {
  console.error('\n  FALLO: ' + e.message + '\n');
  process.exit(1);
});
