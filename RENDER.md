# Montar el servidor en Render, paso a paso

Render tiene plan gratuito, **no pide tarjeta** y habla WebSocket, que es lo
que necesita el juego. Tarda unos 15 minutos, casi todos esperando a que construya
el proyecto.

Antes de nada, una decisión que ahorra Warden el primer despliegue:

> **Crea un repositorio solo con el servidor.** No subas el proyecto entero de
> Android. Render vería un `build.gradle` y puede intentar construir la app, que
> necesita Android SDK, y fallaría. Con un repositorio de 3 archivos va limpio y
> en segundos.

---

## 1. El repositorio (3 archivos)

Crea un repositorio nuevo en GitHub, llamado por ejemplo `ositos-relay`, y
súbele **estos tres archivos**:

```
ositos-relay/
├── relay.js
├── package.json
└── README.md          (opcional, la guia esta dentro)
```

Los tienes en `tools/servidor/` de este proyecto. Lo mas comodo desde el PC, con
Git instalado:

```powershell
cd C:\ruta\del\proyecto\tools\servidor
git init
git add relay.js package.json
git commit -m "Servidor de reenvio de Batalla de Ositos"
git branch -M main
git remote add origin https://github.com/TU-USUARIO/ositos-relay.git
git push -u origin main
```

O, si no quieres usar la terminal, creates el repositorio vacio en GitHub y
arrastras los archivos a la pagina.

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

## Comprobar que va sin telefonos

En el PC, con el servidor ya desplegado, esto te dice si el problema es el
servidor o la red del telefono:

```powershell
$u = "ositos-relay.onrender.com"
# 1. que el servidor responde
(Invoke-WebRequest "https://$u" -UseBasicParsing).Content
# 2. que el handshake de WebSocket llega ahi
$s = New-Object System.Net.Sockets.TcpClient
$r = [System.Security.Cryptography.RandomNumberGenerator]::Create()
```

Mas facil: si la pagina responde y los dos telefonos se encuentran, todo esta
bien. Si la pagina responde pero los telefonos no se ven, casi siempre es que
escribieron **codigos distintos**.

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
