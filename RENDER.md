# Montar el servidor en Render, paso a paso

Render tiene plan gratuito, **no pide tarjeta** y habla WebSocket, que es lo
que necesita el juego. Tarda unos 15 minutos, casi todos esperando a que construya
el proyecto.

Antes de nada, una decisión que ahorra el primer despliegue:

> **El repositorio del servidor va solo, sin el proyecto de Android.** Render
> vería un `build.gradle` e intentaría construir la app, que necesita el SDK de
> Android, y el despliegue fallaría. Con un repositorio de 5 archivos va limpio y
> en segundos.

---

## 1. El repositorio (ya está)

Está creado y subido:

**https://github.com/marceloaliaga102-bot/ositos-relay**

```
ositos-relay/
├── relay.js        el servidor entero
├── package.json    solo para que Render sepa que es Node
├── README.md
├── RENDER.md       esta guia
└── .gitignore
```

Es público. No hay secretos dentro (ni claves, ni datos de nadie): es un
reenviador de mensajes y ya. Por eso Render lo encuentra sin que haya que
autorizarlo de nada.

Si algún dia lo quisieras privado, desde GitHub: **Settings → Danger Zone →
Change visibility**. Si lo haces, después tendras que volver a autorizar a
Render para ese repositorio.

## 2. Crear el servicio

1. Entra en **dashboard.render.com** y pulsa **New +**.
2. Elige **Web Service** (no Static Site, ese es para paginas web).
3. Conecta GitHub si te lo pide y autoriza a Render.
4. Elige el repositorio `ositos-relay`.

## 3. Los campos, uno por uno

Aqui esta todo. **Lo primero que hay que hacer es poner el tipo en Node**, porque
si no Render adivina y con un `package.json` minimo puede equivocarse:

| Campo | Que poner | Por que |
|---|---|---|
| **Name** | `ositos-relay` | Es el nombre del servicio y lo que sale en la direccion. |
| **Region** | **Frankfurt (o el mas cerca de ti)** | El juego va a hacer ida y vuelta por el servidor; si esta lejos, cada pulsacion tarda mas. |
| **Branch** | `main` | Tal como lo subiste. |
| **Root Directory** | *(vacio)* | El archivo esta ya en la raiz del repositorio. |
| **Language / Runtime** | **Node** | **Importante.** Desplegandolo abajo del todo hay un desplegable "Language"; si no lo pones en Node, Render puede elegir otra cosa y fallar. |
| **Build Command** | *(vacio)* | No hay nada que construir: el servidor no tiene dependencias. |
| **Start Command** | `node relay.js` | O `npm start`, que hace lo mismo. |
| **Instance Type** | **Free** | |

## 4. Las variables de entorno

En **Environment**, abajo del todo del formulario, añade:

```
PORT = 8099
```

**Esto es imprescindible.** Sin `PORT`, el servidor arranca en el 80, y ahi no
puede abrirse sin permisos de administrador: veras `EACCES: permission denied` en
los logs. Con `PORT=8099` funciona.

(Si tu proyecto tiene variables antiguas de depuracion, borralas. No hace
falta ninguna mas.)

## 5. Desplegar

Pulsa **Create Web Service**. Veras una consola que va pensando en voz alta.
Deberia decir algo asi:

```
==> Downloading repository...
==> Installing dependencies... (no dice nada: no hay)
==> Starting Node version v22.x
Batalla de Ositos: escuchando en el puerto 8099
```

Si ves `EACCES` o `permission denied`, casi seguro es que falta el `PORT`.
Si ves que intenta instalar cosas de Gradle, es que subiste el proyecto entero:
borra el servicio, sube solo los 3 archivos y repite.

Cuando arriba del todo ponga **Live**, esta listo.

## 6. La direccion

Render te da algo asi:

```
https://ositos-relay.onrender.com
```

Compruebalo en el navegador: tiene que salir un texto como

```
Batalla de Ositos: 0 sala(s) abierta(s)
```

Esa pagina es tambien la que usa Render para ver que el servicio esta vivo, asi
que **no la borres ni la cambies**.

## 7. En los telefonos

En **los dos** (que pueden estar en redes distintas):

**Configuracion → Jugar por internet** → escribe

```
ositos-relay.onrender.com
```

y pulsa **Guardar servidor**.

No pongas `https://` delante, no hace falta: la app lo entiende igual. Si lo
pones, tambien funciona.

## 8. Jugar

1. En uno: **Crear partida → Por internet** → reglas → **Empezar**.
2. Le sale la sala de espera con un **codigo de 6 cifras** y se queda buscando.
3. Pasa ese codigo al otro por WhatsApp.
4. En el otro: **Ingresar a partida** → escribe el codigo → **Entrar**.
5. Cuando se encuentran, la partida **arranca sola en los dos**.

---

## El problema del plan gratuito, y como evitarlo

Render apaga el servicio **tras 15 minutos sin recibir nada**. Cuando lo hace, el
primer mensaje que llegue tarda **hasta 50 segundos** en despertar, y por un
momento puede soltar la conexion a los dos.

Eso se nota: uno crea la partida, espera un minuto y de repente entra. Se
soluciona con un **mantenimiento externo**: un servicio que llame a la pagina
del servidor cada 10 minutos, para que no llegue a dormirse.

Los mas sencillos, gratis:

- **[UptimeRobot](https://uptimerobot.com)**: new monitor, tipo HTTP, direccion
  `https://ositos-relay.onrender.com`, intervalo 10 minutos. Es lo mas facil de
  todos: cuenta gratis y en dos minutos esta.
- **[cron-job.org](https://cron-job.org)**: nueva tarea cada 10 minutos contra
  esa misma direccion.

Con eso Render nunca llega a 15 minutos de inactividad, y la partida empieza
inmediata. **Ganaste los 50 segundos y todo lo que viene de malo**, sin pagar.

## Si se corta a mitad de una partida

Se pierde la partida en curso, pero no se rompe nada: el juego avisa "se perdio la
conexion" y vuelve al menu. Vuelve a crear la partida y ya.

## Comprobar que va, sin telefonos

Pega esto en PowerShell sustituyendo `TU-SERVICIO` por lo que te haya dado
Render. Son dos comprobaciones y te dicen en cual falla:

```powershell
$h = "TU-SERVICIO.onrender.com"

# 1. El proceso responde y el puerto web esta abierto.
#    Debe salir: Batalla de Ositos: 0 sala(s) abierta(s)
(Invoke-WebRequest "https://$h" -UseBasicParsing -TimeoutSec 60).Content

# 2. El saludo de WebSocket llega ahi (el juego se conecta por aqui).
#    Debe salir: HTTP/1.1 101 Switching Protocols
$tcp = New-Object System.Net.Sockets.TcpClient
$tcp.Connect($h, 443)
$ssl = New-Object System.Net.Security.SslStream($tcp.GetStream(), $false, ({ $true }))
$ssl.AuthenticateAsClient($h)
$clave = [Convert]::ToBase64String((1..16 | ForEach-Object { Get-Random -Max 256 }))
$peticion = "GET / HTTP/1.1`r`nHost: $h`r`nUpgrade: websocket`r`n" +
  "Connection: Upgrade`r`nSec-WebSocket-Key: $clave`r`n" +
  "Sec-WebSocket-Version: 13`r`n`r`n"
$bytes = [System.Text.Encoding]::ASCII.GetBytes($peticion)
$ssl.Write($bytes, 0, $bytes.Length)
$buf = New-Object byte[] 200
$n = $ssl.Read($buf, 0, 200)
[System.Text.Encoding]::ASCII.GetString($buf, 0, $n)
$ssl.Dispose()
$tcp.Close()
```

Que significa cada resultado:

| Que pasa | Que significa |
|---|---|
| Ni el 1 llega | El servicio esta dormido (normal los primeros 15 minutos). Espera y repite. |
| 1 responde y 2 sale `101` | **Todo bien.** El servidor vive y acepta el juego. Si los telefonos no se ven, casi seguro es codigo distinto. |
| 1 responde y 2 sale `400` o nada | El despliegue quedo a medias. Mira los logs en Render. |
| `EACCES` en los logs | Falta la variable `PORT = 8099`. |

## Alternativas a Render

| Servicio | Gratis | Tarjeta | Cuando usarlo |
|---|---|---|---|
| **Render** | Si | No | El mas facil. |
| **Koyeb** | Si | No | Si Render te da problemas. Mismo proceso. |
| **Railway** | Con limite | A veces | Solo si ya tienes cuenta. |
| **Fly.io** | Si | **Si** | Si Render se duerme demasiado. Pide tarjeta, cobra 0 sin pasarse. |
| **Tunel desde tu PC** | Si | No | Para probar hoy. `npx localtunnel --port 8099` |

Con el tunel, en vez de subir nada a GitHub:

```powershell
node tools/servidor/relay.js
```

y en otra terminal:

```powershell
npx localtunnel --port 8099
```

Te da una direccion `https://algo.loca.lt` que es la que van a poner los
telefonos. Requiere que el PC este encendido, y la direccion cambia cada vez.
