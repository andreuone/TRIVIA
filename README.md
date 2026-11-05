# Trivia

Juego de preguntas multijugador estilo Kahoot, sin paso de build, alojado en GitHub Pages y con Firebase gratuito como backend. Pensado para unos **250 jugadores y 16 preguntas**, hasta **3 partidas completas al día** sin costo. El detalle está en [docs/estimacion-cuota.md](docs/estimacion-cuota.md).

## Antes de un evento grande

Firebase permite crear **100 cuentas nuevas por hora desde cada IP**, y cada jugador nuevo es una cuenta anónima. Si muchos jugadores comparten la misma Wi-Fi, a partir del número 100 verán un error al entrar.

1. Busca en la consola de Firebase, dentro de Authentication, la opción para programar un aumento temporal de ese límite. La documentación de Firebase no aclara si está disponible en el plan gratuito ni cuánto dura, así que compruébalo con antelación.
2. Si no puedes aumentarlo, pide que entren con datos móviles. Ayuda a repartir las IP, aunque algunos operadores comparten una misma IP entre muchos clientes.

Quien ya entró conserva su cuenta al recargar la página.

## Puesta en marcha

### 1. Crear el proyecto en Firebase

1. Entra en la [consola de Firebase](https://console.firebase.google.com) y crea un proyecto. Se queda en el plan gratuito Spark, que no pide tarjeta.
2. En la página del proyecto, añade una **app web** (icono `</>`). No hace falta activar Firebase Hosting.
3. Copia el objeto `firebaseConfig` que aparece.

### 2. Activar Firestore

En **Firestore Database**, crea la base de datos con el ID predeterminado, en una ubicación cercana a tus jugadores y en modo de producción. La ubicación no se puede cambiar después.

### 3. Activar la autenticación anónima

En **Authentication > Sign-in method**, activa el proveedor **Anónimo**.

### 4. Pegar la configuración

Reemplaza los valores de ejemplo de [firebase-config.js](firebase-config.js) por los de tu proyecto. Estos valores pueden estar en un repositorio público: lo que protege los datos son las reglas.

### 5. Publicar las reglas

Elige una de estas dos opciones:

- **Con la consola:** copia el contenido de [firestore.rules](firestore.rules) en **Firestore Database > Reglas** y pulsa **Publicar**.
- **Con la terminal:** ejecuta el comando siguiente desde esta carpeta, cambiando `TU_PROYECTO` por el ID de tu proyecto.

```bash
firebase deploy --only firestore:rules --project TU_PROYECTO
```

### 6. Desplegar en GitHub Pages

1. Sube esta carpeta a un repositorio de GitHub.
2. En **Settings > Pages**, elige **Deploy from a branch**, la rama `main` y la carpeta `/ (root)`.
3. Tu juego quedará en `https://TU_USUARIO.github.io/TU_REPOSITORIO/`.

### 7. Autorizar el dominio

En **Authentication > Settings > Authorized domains**, añade `TU_USUARIO.github.io`, sin `https://` ni la ruta del repositorio.

### 8. Probar antes del evento

Crea una partida desde `host.html` y únete con tu móvil escaneando el QR.

## Cómo se juega

1. El anfitrión abre `host.html`, prepara las preguntas y pulsa **Crear sala**.
2. Los jugadores escanean el QR o entran en la página e introducen el PIN y un apodo.
3. El anfitrión pulsa **Empezar** y avanza entre pregunta, resultado y top 5.

La pestaña del anfitrión debe seguir abierta, porque es la que calcula los puntajes. Si se recarga, ofrecerá continuar la partida, pero solo en el mismo navegador.

## Formato de las preguntas

Las preguntas se editan en `host.html` y se guardan en ese navegador. También se pueden importar y exportar como JSON. Hay un ejemplo en [data/ejemplo.json](data/ejemplo.json).

```json
{
  "questions": [
    {
      "text": "¿Cuál es la capital de Australia?",
      "options": ["Sídney", "Melbourne", "Canberra", "Perth"],
      "correct": 2,
      "timeLimit": 20,
      "imageUrl": ""
    }
  ]
}
```

| Campo | Descripción |
|---|---|
| `text` | Texto de la pregunta, hasta 300 caracteres |
| `options` | Exactamente 4 opciones, de hasta 120 caracteres cada una |
| `correct` | Índice de la opción correcta, de 0 a 3 |
| `timeLimit` | Segundos para responder, de 5 a 120 |
| `imageUrl` | Opcional. URL `https` de una imagen |

## Puntaje

Una respuesta correcta vale de 1000 puntos (al instante) a 500 (justo al acabar el tiempo), y una incorrecta vale 0. El tiempo se mide con timestamps del servidor. Se aceptan respuestas hasta 1,5 segundos después del límite para compensar la latencia.

## Pruebas locales

No consumen cuota, porque usan el Firebase Emulator Suite. Necesitas Node.js, [Firebase CLI](https://firebase.google.com/docs/cli) y Java 21.

```bash
npm install -g firebase-tools
```

```bash
winget install Microsoft.OpenJDK.21
```

```bash
cd tests
```

```bash
npm install
```

| Comando (desde `tests/`) | Qué hace |
|---|---|
| `npm run test:unit` | Prueba los puntajes y la validación de preguntas; no necesita Java |
| `npm run test:rules` | Prueba las reglas de seguridad contra el emulador |
| `npm run test:load` | Simula una partida de 250 bots y cuenta lecturas y escrituras |
| `npm test` | Ejecuta todo lo anterior |

Para cambiar el tamaño de la simulación, arranca el emulador como se indica abajo y, desde la carpeta del proyecto, ejecuta:

```bash
node tests/load-bots.js --players=100 --questions=20 --limit=4
```

### Jugar en local

En `localhost` la app se conecta sola al emulador y no toca tu proyecto real. Cada pestaña es un usuario distinto, así que puedes simular varios jugadores en el mismo navegador. Ejecuta cada comando en su propia terminal, desde la carpeta del proyecto:

```bash
firebase emulators:start --only auth,firestore --project demo-trivia
```

```bash
npx http-server . -p 5500 -c-1
```

Después abre `http://localhost:5500/host.html`. La interfaz del emulador, con los datos, está en `http://127.0.0.1:4000`.

## Estructura

```
index.html, host.html, play.html   Pantallas
firebase-config.js                 Configuración de tu proyecto
firestore.rules                    Reglas de seguridad
js/firebase.js                     Conexión y versión del SDK
js/join.js, host.js, play.js       Lógica de cada pantalla
js/editor.js, questions.js         Editor y validación de preguntas
js/scoring.js                      Puntajes y datos publicados
js/ui.js                           Utilidades de interfaz
js/vendor/qrcode.js                Librería de QR (MIT, Kazuhiko Arase)
data/ejemplo.json                  10 preguntas de ejemplo
tests/                             Pruebas y simulación de bots
docs/estimacion-cuota.md           Lecturas y escrituras por partida
```

## Modelo de datos

- **`games/{pin}`:** único documento que escuchan los jugadores. Tiene la fase (`lobby`, `question`, `reveal` o `end`), la pregunta actual sin la respuesta y `startedAt`. En `reveal` añade `correct`, `votes`, `top5` y `results`. En `end` conserva `top5` y `results`.
- **`games/{pin}/players/{uid}`:** apodo, puntaje final, `hostUid` y fecha de entrada. Solo lo escucha el anfitrión.
- **`games/{pin}/answers/{qIndex}_{uid}`:** una respuesta por jugador y pregunta, con hora del servidor. Solo lo escucha el anfitrión.

Las preguntas completas, con la respuesta correcta, nunca suben a Firestore antes del resultado: están en el navegador del anfitrión.

## Limitaciones

- **Cuota:** si se agota, el juego deja de funcionar hasta que se reinicia, incluso a mitad de partida. No hay cobros.
- **Confianza en el anfitrión:** los puntajes se calculan en su navegador. Las reglas impiden que un jugador altere los suyos.
- **Validación de tiempos:** las reglas no comprueban que la pregunta siga abierta, porque costaría una lectura por respuesta. Lo comprueba el anfitrión con las horas del servidor.
- **Clasificación pública:** el mapa `results` permite a cualquier jugador técnico ver los puntajes de los demás.
- **Limpieza:** el cliente no puede borrar nada, así que las partidas se acumulan. El plan gratuito incluye 1 GiB, suficiente para cientos de partidas. Para borrar una, ejecuta el comando siguiente. Borrar consume la cuota de borrados (20.000 al día).

```bash
firebase firestore:delete games/123456 --recursive --project TU_PROYECTO
```
