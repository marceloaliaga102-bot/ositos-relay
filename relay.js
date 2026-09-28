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
    sala = { anfitrion: null, invitado: null, t: ahora };
    salas.set(codigo, sala);
  }
  if (sala[rol]) return false;         // ya habia alguien en ese papel
  sala[rol] = cliente;
  sala.t = ahora;
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

    if (!/^[0-9]{6}$/.test(codigo)) {
      error(cliente, 'El codigo de la sala son 6 digitos');
      return;
    }
    cliente.codigo = codigo;
    cliente.rol = anfitrion ? 'anfitrion' : 'invitado';
    if (!registra(codigo, cliente.rol, cliente)) {
      error(cliente, 'Esa sala ya tiene a los dos jugadores');
    }
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
