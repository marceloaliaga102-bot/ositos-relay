# Batalla de Ositos — servidor de reenvío

Este repositorio es **solo el servidor** del juego. La app del teléfono es otro
proyecto; este es el trozo que los manda encontrar.

## Qué hace

Empareja a dos teléfonos por el **código de 6 cifras** de la sala y les pasa los
mensajes. Nada más:

- No juega. La pelea la simula uno de los dos teléfonos.
- No guarda nada. Ni cuentas, ni partidas, ni quién entró.
- No sabe contraseñas ni lee nada del teléfono.
- Una sala se borra sola a los 10 minutos.

No decide nada de la partida. Por eso son 300 líneas y no un proyecto.

## Cómo se arranca

```bash
node relay.js
```

Sin dependencias: no hay `npm install` que hacer. Se imprime `Batalla de Ositos:
escuchando en el puerto 8099`.

## Variables de entorno

| Variable | Por defecto | Para que sirve |
|---|---|---|
| `PORT` | `8099` | El puerto donde escucha. **En Render hay que ponerla a `8099`**: sin ella intenta abrir el 80 y no puede sin permisos de administrador. |
| `PING_MS` | `0` (apagado) | Si es mayor que 0, el servidor se comprueba a sí mismo cada ese tiempo para no dormirse. Apagado a propósito: lo normal en un alojamiento gratuito es que el servicio se apague, y eso se arregla con un mantenimiento externo. |

## Comprobar que funciona, sin teléfonos

```bash
node probar-relay.js
```

Levanta el servidor de verdad, se conecta con dos clientes que hablan el mismo
protocolo que los teléfonos y comprueba que los dos se emparejan, que los
mensajes llegan enteros (incluido uno de 5000 bytes, que es el camino de la
cabecera larga) y que al irse uno el otro se entera al instante.

Si pone **"TODO BIEN"**, el servidor está bien.

## Cómo se despliega

La guía paso a paso para **Render** (gratis, sin tarjeta) está en
**[RENDER.md](RENDER.md)**.

Resumen: subir estos tres archivos a GitHub, en Render crear un **Web Service**,
poner el lenguaje en **Node**, el comando de arranque en `node relay.js` y la
variable `PORT` a `8099`.

## El protocolo

Cada mensaje va con 1 byte de tipo, 4 bytes de largo y el cuerpo. La conexión es
WebSocket, porque los alojamientos gratuitos solo abren el puerto web y un
servidor de TCP en un puerto propio no llegaría a ninguno.

| Tipo | Nombre | Quién lo manda |
|---|---|---|
| 1 | `HELLO` | El invitado: versión, si es anfitrión, código, nombre y osito |
| 2 | `WELCOME` | El anfitrión: reglas, ositos y de qué lado va el que entra |
| 3 | `READY` | El servidor: 1 = llegó el otro, 0 = se fue |
| 4 | `INPUT` | El invitado: su pulsación del frame (6 bytes) |
| 5 | `INPUTS` | El anfitrión: las dos pulsaciones del frame (16 bytes) |
| 6 | `SNAP` | El anfitrión: el estado entero de la pelea, cada medio segundo |
| 7 | `PING` / 8 `PONG` | Mantenimiento |
| 9 | `BYE` | Se va |
| 10 | `ERROR` | Error legible para el jugador |
| 11 | `FIN` | El anfitrión avisa de que la partida acabó |

## Estructura

```
relay.js          el servidor entero
probar-relay.js   la prueba de arriba
package.json      solo para que Render sepa que es Node
RENDER.md         la guía de despliegue
```
