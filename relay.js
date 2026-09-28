#!/usr/bin/env node
/**
 * Servidor de reenvio de Batalla de Ositos, con WebSocket.
 *
 * Por que WebSocket y no TCP suelto: los alojamientos gratuitos solo abren el
 * puerto web (80 y 443). Un servidor que habla TCP en un puerto propio no llega
 * a ninguno de ellos. En cambio, esto es web normal y corre en cualquier
 * alojamiento gratis, sin tarjeta y sin pagar.
 *
 * Que hace: empareja a dos telefonos por el codigo de la sala y les pasa los
 * mensajes. No juega, no simula la pelea, no guarda nada y no sabe contrasenas.
 *
 * Sin dependencias: es este archivo y ya. No hace falta `npm install`.
 *
 *     node relay.js
 *     PORT=8099 node relay.js
 *
 * Los mensajes van igual que en la app: 1 byte de tipo, 4 de largo, cuerpo.
 *
 *     1 HELLO    version(1) anfitrion(1) codigo(texto) nombre(texto) osito(texto)
 *     2 WELCOME  reglas, ositos y de que lado va el que entra
 *     3 READY    1 = llego el otro, 0 = se fue
 *     4 INPUT    pulsacion del invitado
 *     5 INPUTS   las dos pulsaciones del anfitrion
 *     6 SNAP     estado entero de la pelea
 *     7 PING     8 PONG     9 BYE    10 ERROR    11 FIN
 *
 * Donde instalarlo gratis: Render, Railway, Fly.io, Cloudflare Workers con Node,
 * o cualquier hosting de Node. Se sube el archivo y se arranca con
 * `node relay.js`. En Render, ademas, ya detectan el puerto.
 */

'use strict';

const http = require('http');
const crypto = require('crypto');

const PUERTO = Number(process.env.PORT) || 8099;
const VERSION = 1;

/**
 * Cada cuanto el servidor se comprueba a si mismo para no dormirse, en
 * milisegundos. 0 = apagado, que es lo de por defecto: en un alojamiento
 * gratuito lo normal es que se apague, y eso se arregla con un mantenimiento
 * externo, no con esto.
 */
const MANTENER_DESPERTADO = Number(process.env.PING_MS) || 0;

/** Puerto que usan los alojamientos cuando no se pone PORT. */
const PUERTO_POR_DEFECTO = 80;

const T_HELLO = 1, T_WELCOME = 2, T_READY = 3;
const T_INPUT = 4, T_INPUTS = 5, T_SNAP = 6;
const T_PING = 7, T_PONG = 8, T_BYE = 9, T_ERROR = 10, T_FIN = 11;
const T_LISTAR = 12, T_SALAS = 13;
const T_INFO = 14;

/** Una sala olvidada se borra sola pasado este tiempo. */
const DURACION_SALA = 10 * 60 * 1000;

/** codigo -> { anfitrion, invitado, t } */
const salas = new Map();

// ---------------------------------------------------------------- WebSocket

/**
 * Acepta la conexion y la pasa a WebSocket. Sin dependencias: se implementa
 * solo el handshake y los dos tipos de trama que hacen falta.
 *
 * El rebuke se comprueba con SHA-1, que es lo que manda el protocolo. No es una
 * decision de seguridad: es un comprobante de que la respuesta corresponde a la
 * peticion, para que un cache viejo no se pueda hacer pasar por el servidor.
 */
function acepta(req, socket) {
  const clave = req.headers['sec-websocket-key'];
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !clave) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  const acepta = crypto.createHash('sha1')
    .update(clave + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acepta}\r\n\r\n`
  );
  socket.setNoDelay(true);

  // Los fotogramas del cliente van enmascarados; los del servidor no.
  nuevoCliente(socket, req.socket.remoteAddress);
}

function nuevoCliente(socket, direccion) {
  const cliente = { socket, rol: null, codigo: null, vivo: true };
  let buffer = Buffer.alloc(0);
  console.log('conectado', direccion);

  socket.on('data', (trozo) => {
    buffer = Buffer.concat([buffer, trozo]);
    // Puede venir mas de una trama en el mismo paquete.
    while (cliente.vivo) {
      const trama = leeTrama(buffer, true);
      if (!trama) break;
      buffer = buffer.slice(trama.tamano);
      if (trama.opcode === 0x8) {           // cierre
        cliente.vivo = false;
        socket.end();
        break;
      }
      if (trama.opcode === 0x9) {           // ping
        socket.write(armaTrama(trama.carga, 0xA));
        continue;
      }
      if (trama.opcode === 0x1 || trama.opcode === 0x2) {
        recibe(cliente, trama.carga);
      }
    }
  });

  const seFue = () => sale(cliente);
  socket.on('close', seFue);
  socket.on('error', seFue);
  socket.on('end', seFue);
}

/** Lee una trama. Si esta incompleta devuelve null y no se pierde nada. */
function leeTrama(buf, conMascara) {
  if (buf.length < 2) return null;
  const byte0 = buf[0];
  const byte1 = buf[1];
  const opcode = byte0 & 0x0f;
  const enmascarada = (byte1 & 0x80) !== 0;
  let largo = byte1 & 0x7f;
  let pos = 2;

  if (largo === 126) {
    if (buf.length < pos + 2) return null;
    largo = buf.readUInt16BE(pos);
    pos += 2;
  } else if (largo === 127) {
    if (buf.length < pos + 8) return null;
    largo = Number(buf.readBigUInt64BE(pos));
    pos += 8;
  }

  let mascara = null;
  if (enmascarada) {
    if (conMascara && buf.length < pos + 4) return null;
    mascara = buf.slice(pos, pos + 4);
    pos += 4;
  }
  if (buf.length < pos + largo) return null;

  let carga = buf.slice(pos, pos + largo);
  if (mascara) {
    // El cliente manda cada byte cambiando de bit segun la mascara. Sin esto
    // el mensaje llega como ruido.
    const copia = Buffer.from(carga);
    for (let i = 0; i < copia.length; i++) copia[i] ^= mascara[i % 4];
    carga = copia;
  }
  return { opcode, carga, tamano: pos + largo };
}

/** Arma una trama de texto (o de control) ya sin máscara. */
function armaTrama(carga, opcode = 0x1) {
  const largo = carga.length;
  let cabecera;
  if (largo < 126) {
    cabecera = Buffer.alloc(2);
    cabecera[1] = largo;
  } else if (largo < 65536) {
    cabecera = Buffer.alloc(4);
    cabecera[1] = 126;
    cabecera.writeUInt16BE(largo, 2);
  } else {
    cabecera = Buffer.alloc(10);
    cabecera[1] = 127;
    cabecera.writeBigUInt64BE(BigInt(largo), 2);
  }
  cabecera[0] = 0x80 | opcode;   // FIN + opcode
  return Buffer.concat([cabecera, carga]);
}

function envia(cliente, tipo, cuerpo = Buffer.alloc(0)) {
  if (!cliente || !cliente.vivo) return;
  const mensaje = Buffer.alloc(5 + cuerpo.length);
  mensaje[0] = tipo;
  mensaje.writeInt32BE(cuerpo.length, 1);
  cuerpo.copy(mensaje, 5);
  try {
    cliente.socket.write(armaTrama(mensaje));
  } catch (e) {
    cliente.vivo = false;
  }
}

function error(cliente, texto) {
  const b = Buffer.from(texto, 'utf8');
  const cuerpo = Buffer.alloc(4 + b.length);
  cuerpo.writeUInt32BE(b.length, 0);
  b.copy(cuerpo, 4);
  envia(cliente, T_ERROR, cuerpo);
}

// ------------------------------------------------------------------ salas

/** Una sala esta llena cuando ya hay un jugador en cada papel. */
function llena(sala) {
  return !!(sala.anfitrion && sala.invitado);
}

function registra(codigo, rol, cliente) {
  let sala = salas.get(codigo);
  const ahora = Date.now();
  if (!sala || (ahora - sala.t > DURACION_SALA && !llena(sala))) {
    sala = { anfitrion: null, invitado: null, t: ahora, nombre: '', reglas: null };
    salas.set(codigo, sala);
  }
  if (sala[rol]) return false;         // ya habia alguien en ese papel
  sala[rol] = cliente;
  sala.t = ahora;
  // El nombre de la sala **no** es el del jugador: lo pone el anfitrion despues
  // con el mensaje de INFO. Aqui solo se deja un nombre por defecto para que la
  // lista tenga algo que enseñar en los primeros milisegundos, antes de que
  // llegue ese mensaje.
  if (!sala.nombre) {
    sala.nombre = cliente.nombre ? `Sala de ${cliente.nombre}`.slice(0, 28) : '';
  }
  // La lista se refresca sola cada pocos segundos en el movil, asi que no
  // hace falta avisar a nadie aqui.
  if (!llena(sala)) return true;
  if (!llena(sala)) return true;

  // Los dos dentro: se avisa a los dos y empieza la pelea.
  const otro = sala.anfitrion === cliente ? sala.invitado : sala.anfitrion;
  envia(cliente, T_READY, Buffer.from([1]));
  envia(otro, T_READY, Buffer.from([1]));
  console.log(`sala ${codigo}: los dos dentro`);
  return true;
}

function reenvia(codigo, emisor, tipo, cuerpo) {
  const sala = salas.get(codigo);
  if (!sala) return;
  sala.t = Date.now();
  const destino = sala.anfitrion === emisor ? sala.invitado : sala.anfitrion;
  if (destino) envia(destino, tipo, cuerpo);
}

function sale(cliente) {
  if (!cliente || !cliente.vivo) return;
  cliente.vivo = false;
  const { codigo, rol } = cliente;
  if (!codigo || !rol) {
    try { cliente.socket.destroy(); } catch (e) { }
    return;
  }
  const sala = salas.get(codigo);
  if (!sala) return;
  if (sala[rol] === cliente) sala[rol] = null;

  const queda = sala.anfitrion || sala.invitado;
  if (!queda) {
    salas.delete(codigo);
    console.log(`sala ${codigo}: se cierra`);
  } else {
    // Que se entere ya, y no espere a que expire el reloj.
    envia(queda, T_READY, Buffer.from([0]));
    console.log(`sala ${codigo}: se fue el ${rol}`);
  }
  try { cliente.socket.destroy(); } catch (e) { }
}

// ------------------------------------------------------------- protocolo

function recibe(cliente, mensaje) {
  if (!mensaje || mensaje.length < 1) return;
  const tipo = mensaje[0];
  const cuerpo = mensaje.slice(5);      // 1 de tipo + 4 de largo
  if (process.env.RELAY_DEBUG) console.log(`recibe tipo ${tipo} de ${cuerpo.length} bytes`);

  if (tipo === T_HELLO) {
    if (cuerpo.length < 2) return;
    if (cuerpo[0] !== VERSION) {
      error(cliente, 'Versiones distintas: actualiza la app');
      return;
    }
    const anfitrion = cuerpo[1] !== 0;
    let pos = 2;
    const leido = leeTexto(cuerpo, pos);
    const codigo = leido.texto.trim().toUpperCase();
    pos = leido.pos;
    // El nombre del jugador. Lo siguiente en el saludo es su osito, que aqui no
    // hace falta para nada: el reparto de ositos lo hace el anfitrion al mandar
    // las reglas. Se lee el nombre solo para tener algo que enseñar en la lista.
    const leidoNombre = leeTexto(cuerpo, pos);
    const nombre = leidoNombre.texto;

    if (!/^[0-9]{6}$/.test(codigo)) {
      error(cliente, 'El codigo de la sala son 6 digitos');
      return;
    }
    cliente.codigo = codigo;
    cliente.nombre = nombre.slice(0, 28);
    cliente.rol = anfitrion ? 'anfitrion' : 'invitado';
    if (!registra(codigo, cliente.rol, cliente)) {
      error(cliente, 'Esa sala ya tiene a los dos jugadores');
    }
  } else if (tipo === T_INFO) {
    // Las reglas de la sala. El anfitrion las manda al abrir, para que quien
    // mira la lista sepa de que va la partida antes de entrar. Si no vinieran,
    // la lista solo podria decir el codigo y el nombre, que es menos util.
    if (cliente.rol === 'anfitrion' && cliente.codigo) {
      anotaInfo(cliente.codigo, cuerpo);
    }
  } else if (tipo === T_LISTAR) {
    // Pedir la lista no es entrar en nada. Por eso va antes que el "primero
    // hay que entrar en la sala": quien llega aqui solo esta mirando.
    listaSalas(cliente);
  } else if (tipo === T_PING) {
    envia(cliente, T_PONG);
  } else if (tipo === T_BYE) {
    cliente.vivo = false;
    try { cliente.socket.end(); } catch (e) { }
  } else {
    if (!cliente.codigo) {
      error(cliente, 'Primero hay que entrar en la sala');
      return;
    }
    reenvia(cliente.codigo, cliente, tipo, cuerpo);
  }
}

/**
 * Lo que el anfitrion ha mandado de su sala: las reglas y el nombre.
 *
 * El nombre va **aqui** y no en el saludo a proposito. En el saludo solo se
 * presenta el jugador; las reglas y el nombre de la sala se eligen despues, en
 * la pantalla de crear partida. Mandandolo todo junto secia mas corto, pero
 * obligaria al servidor a entender reglas para algo que no decide: el servidor
 * no juega, no simula y no manda sobre nada de la partida. Solo guarda estos
 * datos para poder enseñarlos en la lista de salas.
 *
 * El cuerpo es: version(1) mapa(1) noche(1) duracion(4) amor(4) texto.
 */
function anotaInfo(codigo, cuerpo) {
  const sala = salas.get(codigo);
  if (!sala) return;
  if (cuerpo.length < 15) return;
  sala.reglas = {
    mapa: cuerpo[1],
    noche: cuerpo[2] !== 0,
    duracion: cuerpo.readInt32BE(3),
    amor: cuerpo.readInt32BE(7),
  };
  const nombre = leeTexto(cuerpo, 11);
  // Un nombre vacio no borra el que habia: si la app no lo manda, se deja el
  // que se sepa y ya.
  if (nombre.texto.trim()) sala.nombre = nombre.texto.trim().slice(0, 28);
}

/**
 * Escribe un texto con su longitud delante: 4 bytes, como hace la app.
 *
 * Se limita a 28 caracteres porque lo que sale es a pantalla, en la lista de
 * salas de cualquiera. Sin tope, un nombre larguisimo descuadra la pantalla del
 * otro.
 */
function texto(valor) {
  const b = Buffer.from(String(valor || '').slice(0, 28), 'utf8');
  const sal = Buffer.alloc(4 + b.length);
  sal.writeUInt32BE(b.length, 0);
  b.copy(sal, 4);
  return sal;
}

/**
 * La lista de salas abiertas, para quien la pide.
 *
 * Se mandan solo las que tienen a alguien dentro esperando: una sala vacia no
 * sirve para nada y solo haria ruido. Se filtran las llenas tambien, porque no
 * se puede entrar en ellas.
 */
function listaSalas(cliente) {
  const ahora = Date.now();
  const visibles = [];
  for (const [codigo, sala] of salas) {
    if (!llena(sala)) continue;
    if (ahora - sala.t > DURACION_SALA) continue;
    const r = sala.reglas;
    visibles.push({
      codigo,
      nombre: (sala.nombre || '').trim() || `Sala de ${codigo.slice(-2)}`,
      mapa: r ? r.mapa : 0,
      noche: r ? r.noche : false,
      duracion: r ? r.duracion : 0,
      amor: r ? r.amor : 0,
      hace: Math.floor((ahora - sala.t) / 1000),
    });
  }
  // De las mas nueva a mas vieja: la que se acaba de abrir es la que mas
  // probabilidad tiene de seguir esperando a alguien.
  visibles.sort((a, b) => a.hace - b.hace);
  // Un tope por si alguien abre muchisimas salas: el mensaje tiene que caber
  // comodo en una trama.
  const hasta = visibles.slice(0, 50);

  const partes = [Buffer.from([VERSION]), enteroBE(hasta.length)];
  for (const s of hasta) {
    partes.push(
      texto(s.codigo), texto(s.nombre),
      Buffer.from([s.mapa, s.noche ? 1 : 0]),
      enteroBE(s.duracion), enteroBE(s.amor),
      enteroBE(2), enteroBE(s.hace),
    );
  }
  envia(cliente, T_SALAS, Buffer.concat(partes));
}

/** Entero de 4 bytes en grande endian, que es como los escribe la app. */
function enteroBE(v) {
  const b = Buffer.alloc(4);
  b.writeInt32BE(v | 0, 0);
  return b;
}

function leeTexto(buf, desde) {
  if (buf.length < desde + 4) return { texto: '', pos: buf.length };
  // Ojo: la longitud son 4 bytes, no 2. Es lo que escribe la app, y si aqui
  // se leen 2 el saludo llega partido y el codigo sale mal siempre.
  const largo = buf.readUInt32BE(desde);
  const ini = desde + 4;
  if (largo < 0 || ini + largo > buf.length) return { texto: '', pos: buf.length };
  return { texto: buf.slice(ini, ini + largo).toString('utf8'), pos: ini + largo };
}

// ------------------------------------------------------------------ arranque

const servidor = http.createServer((req, res) => {
  // Esta pagina es la que usa Render para comprobar que el servicio esta vivo,
  // y tambien sirve para que un servicio externo de mantenimiento la llame.
  // Por eso devuelve 200 siempre que el proceso responde.
  const ruta = (req.url || '/').split('?')[0];
  if (ruta === '/' || ruta === '/estado') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`Batalla de Ositos: ${salas.size} sala(s) abierta(s)\n`);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Batalla de Ositos. El juego se conecta por WebSocket.\n');
});

servidor.on('upgrade', acepta);

// Borra las salas muertas, para que no crezcan sin fin.
setInterval(() => {
  const ahora = Date.now();
  for (const [codigo, sala] of salas) {
    if (ahora - sala.t > DURACION_SALA && !llena(sala)) salas.delete(codigo);
  }
}, 30000);

servidor.listen(PUERTO, () => {
  console.log(`Batalla de Ositos: escuchando en el puerto ${PUERTO}`);
  if (PUERTO === PUERTO_POR_DEFECTO) {
    console.log('Aviso: estas en el puerto por defecto (80). En un alojamiento normal');
    console.log('pon PORT=8099, porque el puerto 80 necesita permisos de administrador.');
  }
  if (MANTENER_DESPERTADO > 0) {
    console.log(`Manteniendose despierto cada ${MANTENER_DESPERTADO / 1000} s (PING_MS).`);
    setInterval(() => {
      // Un plan gratuito apaga el servicio si pasa ratos sin recibir nada. Esta
      // peticion a si mismo lo evita, pero **no** se pone por defecto: en Render
      // conviene usar un mantenimiento externo, que es lo que esta previsto.
      const peticion = http.get(
        { host: '127.0.0.1', port: PUERTO, path: '/estado' },
        (r) => r.resume()
      );
      peticion.on('error', () => { });
      peticion.setTimeout(5000, () => peticion.destroy());
    }, MANTENER_DESPERTADO);
  }
});
