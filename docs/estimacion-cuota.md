# Estimación de cuota

Partida de referencia: **250 jugadores y 16 preguntas**, con el diseño final.

Cuota gratuita de Firestore (plan Spark): 50.000 lecturas y 20.000 escrituras al día. Se reinicia hacia la medianoche, hora del Pacífico.

## Lecturas por partida

| Concepto | Cálculo | Lecturas |
|---|---|---|
| Jugadores escuchando el estado | 250 × 34 versiones | 8.500 |
| Validar el PIN al unirse | 250 × 1 | 250 |
| Anfitrión: obtener `startedAt` | 16 × 1 | 16 |
| Anfitrión: lista de jugadores | 250 × 1 | 250 |
| Anfitrión: respuestas | 250 × 16 | 4.000 |
| Margen por reconexiones (suposición) | 250 × 3 | 750 |
| **Total** | | **~13.800** |

Las 34 versiones del estado son: crear la sala, 16 preguntas, 16 resultados y el final. Los jugadores reciben las 34 si se unen antes de que empiece la partida.

## Escrituras por partida

| Concepto | Cálculo | Escrituras |
|---|---|---|
| Documento de estado | 34 | 34 |
| Altas de jugadores | 250 | 250 |
| Respuestas | 250 × 16 | 4.000 |
| Puntajes finales | Hasta 250 | 250 |
| **Total** | | **~4.500** |

## Medición con la simulación

Dos ejecuciones de `npm run test:load` contra el emulador, con 250 bots, 16 preguntas y 4 segundos por pregunta:

| | Lecturas | Escrituras |
|---|---:|---:|
| Primera ejecución | 12.802 | 4.322 |
| Segunda ejecución | 12.796 | 4.342 |

Salen algo por debajo de la estimación porque los bots no se reconectan y un 5 % no responde en cada pregunta. Es un recuento desde el cliente: el emulador no reproduce la facturación real.

En la segunda ejecución, 28 respuestas llegaron después de cerrar la ronda, todas en la última pregunta, y el emulador tardó hasta 3,9 s en confirmar alguna escritura. En la primera ejecución faltaron 2. La simulación ejecuta los 250 clientes y el emulador en un solo equipo, así que no indica cuántas llegarían tarde en Firebase real. Conviene comprobarlo en un ensayo con móviles reales.

## Partidas al día

- Por lecturas: 50.000 / 13.800 = 3,6
- Por escrituras: 20.000 / 4.500 = 4,4

El límite son las lecturas: **3 partidas completas al día**.

## Fórmula para otros tamaños

Con `J` jugadores y `P` preguntas:

- Lecturas: `J × (2P + 2) + 2J + J × P + P + 3J` (los últimos `3J` son el margen de reconexión)
- Escrituras: `(2P + 2) + J + J × P + J`

| Jugadores | Preguntas | Lecturas | Escrituras | Partidas al día |
|---|---:|---:|---:|---:|
| 50 | 16 | ~2.770 | ~930 | 18 |
| 100 | 20 | ~6.720 | ~2.240 | 7 |
| 250 | 16 | ~13.800 | ~4.500 | 3 |
| 250 | 30 | ~24.300 | ~8.060 | 2 |

## Decisiones que mantienen bajo el consumo

- **Los jugadores solo escuchan un documento.** Puntos y posición viajan en el mapa `results`.
- **El temporizador, el conteo en vivo y el top 5 no se escriben.** Cada escritura en el estado se multiplica por el número de jugadores.
- **El puntaje de `players` se escribe solo al final**, y el anfitrión ya no escucha esa colección en ese momento.
- **Las reglas no usan `get()` ni `exists()`.** Firebase cobra cada llamada como una lectura, lo que sumaría miles por partida.

## Qué puede aumentar el consumo

- **Reconexiones:** cada móvil que se reconecta vuelve a leer el estado. Si el anfitrión recarga la página, vuelve a leer jugadores y respuestas de la pregunta en curso.
- **Reintentos de unirse:** cada intento lee el documento de la partida.
- **Consola de Firebase:** navegar por los datos en la consola también consume lecturas.
- **Otras partidas el mismo día:** la cuota es por proyecto, no por partida.
