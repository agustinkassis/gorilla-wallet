# CLI local `gorila`

La CLI funciona con Node 24 y las dependencias del checkout, sin iniciar Next.js.
Comparte wallets, seeds, labels, fuentes y SQLite con la web. No usa BDK ni RPC.

## Instalación

Desde el checkout de `gorila-wallet`:

```sh
nvm use
corepack enable
pnpm install
pnpm link --global
gorila --help
```

Si pnpm todavía no tiene directorio global, ejecutar `pnpm setup` y abrir una
terminal nueva. También se puede ejecutar `node bin/gorila.mjs` desde el checkout.
El enlace necesita conservar el checkout y sus dependencias. No publica el paquete.

El launcher encuentra el proyecto mediante su propia ruta, carga los archivos
`.env` con el mismo cargador de Next.js y aplica las migraciones aditivas antes de
ejecutar comandos. No inicia el servidor web. Las rutas relativas de SQLite se
resuelven desde el proyecto; los archivos de secretos se resuelven desde el
directorio donde se invocó `gorila`.

`DATABASE_URL` conserva su prioridad sobre `.env`. Para compartir una base del
desktop o de otro checkout, indicar la misma ruta absoluta, por ejemplo
`DATABASE_URL=file:/ruta/wallet.db gorila wallet list`.

## Opciones comunes

`--wallet ID_OR_NAME` selecciona una wallet. Con una sola se elige automáticamente;
con varias es obligatorio identificarla. Los nombres duplicados se rechazan y se
puede usar el ID. `--json` escribe un único resultado JSON en stdout; prompts,
revisión del envío y errores van a stderr. Los errores tienen código de salida 1.
La salida normal usa texto con nombres de campos.

`--timeout SECONDS` limita la espera de sincronización (120 segundos por defecto).
Cada consulta abre una sesión para las wallets y cadenas solicitadas, espera
descubrimiento e historial frescos y cierra conexiones y timers al terminar. No
cambia la red elegida en la web. `receive` y `addresses` sincronizan BTC y XBT para
considerar el uso compartido de direcciones. BTC y XBT operan sobre la familia
mainnet. `--chain regtest` selecciona una familia local independiente, con
direcciones `bcrt1` y cuenta `m/84'/1'/0'`.

## Wallets y secretos

```sh
gorila wallet list
gorila wallet create --name ahorro                 # 24 palabras por defecto
gorila wallet create --name gastos --words 12
gorila wallet import --name recuperada             # prompt oculto para las palabras
gorila wallet import --name recuperada --seed-file ./seed.txt
gorila wallet export-seed --wallet ahorro
gorila wallet export-seed --wallet ahorro --include-passphrase
gorila wallet descriptor --wallet ahorro
```

La creación devuelve las nuevas palabras para permitir su respaldo. La importación
acepta exactamente 12 o 24 palabras BIP39 en inglés, con checksum válido.
Las wallets usan P2WPKH BIP84, cuenta `m/84'/0'/0'`, recepción `/0/i` y cambio `/1/i`.

La contraseña de cifrado es opcional, como en la web: en una terminal se solicita
oculta y puede dejarse vacía. En automatización, omitirla crea una wallet sin
contraseña. `--password-file FILE` permite suministrarla explícitamente; las
contraseñas no vacías necesitan al menos 8 caracteres. Exportar o firmar una wallet
cifrada exige la contraseña, mediante prompt oculto o archivo.

La passphrase BIP39 deriva otra wallet y es distinta de la contraseña de cifrado.
`--passphrase` la pide mediante prompt oculto; `--passphrase-file FILE` la lee de
un archivo al crear o importar. La exportación solo incluye la passphrase con
`--include-passphrase`. Se elimina un salto de línea final de los archivos de
secretos. Ningún secreto se acepta como valor directo de un argumento.

Sin terminal, faltar un secreto obligatorio produce error. Las wallets watch-only
existentes pueden consultar, recibir y exportar descriptores, pero no exportar
seed ni firmar. Los descriptores públicos `wpkh` incluyen checksum, origen con
fingerprint, ruta y xpub, para recepción y cambio; no contienen claves privadas.

## Direcciones y labels

```sh
gorila receive --wallet ahorro --label "factura 123"
gorila receive --wallet ahorro
gorila receive --wallet ahorro --next
gorila addresses --wallet ahorro
gorila address label bc1q... "cliente" --wallet ahorro
```

`receive` mantiene un cursor persistente por wallet y familia. Repite la dirección
actual hasta que tenga historial en BTC o XBT; `--next` avanza manualmente. Los
saltos no marcan direcciones como usadas. El descubrimiento incluye las direcciones
saltadas y extiende el gap más allá del cursor. Los avances simultáneos de procesos
se serializan mediante una transacción de SQLite.

`addresses` muestra recepción y cambio, índice, label, uso y conteo de txids
distintos por cadena. Los labels de dirección son por cadena, como en la web: la
misma dirección puede tener un label en BTC y otro en XBT. `receive --label`,
`addresses` y `address label` usan `--chain` (BTC por defecto). `address label`
exige una dirección ya derivada para esa wallet; se puede ejecutar `addresses`
para descubrirla.

## Balances, historial y estado

```sh
gorila balance --wallet ahorro --chain all
gorila balance --chain btc --all-wallets --json
gorila transactions --wallet ahorro --chain xbt
gorila tx-status TXID --wallet ahorro --chain btc
```

Los balances muestran confirmado, pendiente y total en satoshis por wallet y
moneda. BTC y XBT nunca se suman entre sí. `balance` usa `all` por defecto;
`transactions`, `tx-status` y `send` exigen `--chain btc|xbt|regtest`.
`all` conserva su significado BTC + XBT; regtest se selecciona explícitamente.
Una wallet cifrada anterior que aún no tenga cuenta regtest necesita desbloquearla
una vez: los comandos de regtest aceptan `--password-file FILE` para habilitarla.

El historial muestra txid, importe neto, fecha y confirmaciones. `tx-status`
consulta primero el historial fresco de la wallet; para txids externos usa las
fuentes mempool configuradas, incluido el tip para calcular confirmaciones.
`found: false` indica respuesta 404; si ninguna fuente pudo responder, devuelve
un error de servidor inaccesible. Sin wallets también se puede consultar un txid
externo.

## Fuentes compartidas

```sh
gorila config show
gorila config set --chain btc \
  --electrum ssl://electrum.example.org:50002 \
  --electrum tcp://fulcrum.example.org:50001 \
  --mempool https://mempool.example.org
gorila config set --chain xbt \
  --electrum ssl://blake.example.org:50002 \
  --mempool https://blake-explorer.example.org
```

Las opciones repetidas conservan el orden de failover. Se usan las mismas
validaciones de la web: hasta 10 URLs por lista, Electrum `tcp://`, `ssl://` o
`tls://host:port`, mempool HTTP(S). Electrs y Fulcrum se configuran como servidores
Electrum. Si se omite una lista, se conserva. `config show` muestra URLs efectivas
y procedencia: Settings, `.env/environment` o defaults. Prioridad: Settings →
variables de entorno/`.env` → defaults. Estos cambios son visibles en la web.
Recargar la web inicia una sesión que lee los cambios realizados por otro proceso.

## Enviar

```sh
gorila send --wallet ahorro --chain btc --to bc1q... --amount-sats 15000 \
  --message "factura 123" --fee-rate 2
gorila send --wallet ahorro --chain xbt --to bc1q... --amount-sats 15000 \
  --fee-rate 2 --password-file ./password.txt --yes --json
```

`--amount-sats` exige un entero positivo; `--fee-rate` se expresa en sat/vB.
Sin tarifa explícita se usa la estimación de una hora. Si las fuentes no ofrecen
estimaciones, se exige `--fee-rate`. La tarifa debe estar entre 1 y 1000 sat/vB y
no ser inferior al mínimo informado por la red.

La selección de monedas, como en la web, excluye outputs congelados, monedas
no confirmadas recibidas de terceros y monedas que cuestan más de lo que valen.
Se construye una PSBT con
el núcleo compartido y se muestra en stderr la revisión completa: inputs,
destino, cambio, comisión, tamaño y script OP_RETURN. Solo después se solicita
confirmación y contraseña para firmar y publicar. Escribir algo distinto de
`yes`, o cancelar, termina sin publicar; sin terminal se exige `--yes`.

BTC incluye siempre el OP_RETURN de protección, con el mensaje UTF-8 opcional y
relleno hasta el tamaño mínimo. XBT rechaza `--message` y firma con
`SIGHASH_UNIFIED` (`0x21`). Los servicios compartidos verifican claves, prevouts,
outputs, monedas congeladas y límites de comisión; web y CLI aplican las mismas
validaciones de publicación normal. Un rechazo de la red se devuelve como error.

## Reenvío automático

Una regla de reenvío vigila una dirección A de la wallet y, en cada ejecución,
envía todas sus monedas a una dirección B con un OP_RETURN. gorila instala una
entrada propia en el crontab del usuario.

```sh
gorila forward add --wallet ahorro --chain btc --from bc1qA... --to bc1qB... \
  --every 5 --max-fee-rate 10
gorila forward add --wallet ahorro --chain btc --from bc1qA... --to bc1qB... \
  --every 60 --max-fee-rate 5 --min-conf 3 --message "pago reenviado"
gorila forward list
gorila forward show 1a2b3c4d --runs 50
gorila forward run 1a2b3c4d --dry-run
gorila forward remove 1a2b3c4d
```

- **A** tiene que ser una dirección ya derivada de la wallet (ver `addresses`);
  **B** puede ser cualquier dirección de la cadena. Cada ejecución gasta solo las
  monedas de A, sin cambio: B recibe el total menos la comisión.
- **Cadenas:** `btc` y `regtest`. XBT no admite OP_RETURN y se rechaza.
- **OP_RETURN:** sin `--message`, cada envío lleva 90 bytes aleatorios nuevos.
  Con `--message`, ese texto UTF-8, rellenado hasta el mínimo de BTC.
- **Confirmaciones:** `--min-conf` (1 por defecto). Las monedas con menos
  confirmaciones esperan a la siguiente ejecución.
- **Comisión:** la estimación de una hora de la red. Si supera
  `--max-fee-rate`, la ejecución no envía, registra `skipped` y vuelve a
  intentar en el próximo ciclo.
- **Intervalo:** `--every` acepta 1, 2, 3, 4, 5, 6, 10, 12, 15, 20 o 30 minutos,
  o 60, 120, 180, 240, 360, 480, 720 o 1440 (horas enteras que dividen el día).
- **Wallets cifradas:** necesitan `--password-file` con permisos `600`. Se
  verifica la contraseña al crear la regla y el cron lee el archivo en cada envío.

Crear una regla pide confirmación en la terminal, o `--yes`. Cada regla ocupa un
bloque `# BEGIN gorila-forward ID` … `# END gorila-forward ID`; el resto del
crontab no se toca. La línea usa rutas absolutas a Node, al CLI y a la base de
datos, y conserva `NODE_EXTRA_CA_CERTS` si estaba definido. La salida de cada
ejecución se agrega a `~/.local/state/gorila/forward-ID.log` (o
`$XDG_STATE_HOME/gorila/`).

`list` muestra si cada bloque de cron está `installed` o `missing` y el
resultado de la última ejecución. `show` agrega la línea de cron, la ruta del log
y el historial de ejecuciones: `sent` con su txid, `skipped` o `error` con el
motivo. Los chequeos sin monedas nuevas no se registran; solo actualizan la hora
del último chequeo. `remove` quita el bloque del crontab y borra la regla y su
historial; el log se conserva.

Dos ejecuciones solapadas de la misma regla no envían dos veces: la segunda sale
con `busy`. Las monedas ya reenviadas no se vuelven a usar mientras su
transacción siga en la red. `run --dry-run` muestra el envío que se haría sin
firmar ni publicar. `GORILA_CRONTAB_BIN` reemplaza el binario `crontab`, para
pruebas.

## Bitcoin regtest

Regtest permite probar recepción, firma y publicación contra un nodo Bitcoin
local. Los comandos usan la misma implementación que BTC, con direcciones
`bcrt1`, firma SIGHASH_ALL y OP_RETURN de al menos 84 bytes en los envíos.
Los cursores y datos de red están separados de mainnet y testnet.

Configurá un servidor Electrum y una API compatible con mempool para tu nodo:

```sh
export DATABASE_URL=file:./data/regtest.db
gorila config set --chain regtest \
  --electrum tcp://127.0.0.1:50001 \
  --mempool http://127.0.0.1:3000
gorila wallet create --name prueba
gorila receive --wallet prueba --chain regtest
gorila wallet descriptor --wallet prueba --chain regtest
gorila balance --wallet prueba --chain regtest
gorila transactions --wallet prueba --chain regtest
```

También se pueden indicar las fuentes mediante `REGTEST_ELECTRUM` y
`MEMPOOL_REGTEST_URL`; la configuración guardada tiene prioridad. El puerto HTTP
debe ofrecer los endpoints `/api/...` usados por mempool; Esplora sin ese prefijo
necesita un proxy que lo adapte.

Tras financiar y confirmar la dirección desde tu nodo:

```sh
gorila send --wallet prueba --chain regtest --to bcrt1... \
  --amount-sats 10000 --fee-rate 2 --message "prueba local"
gorila tx-status TXID --wallet prueba --chain regtest
```

La suite automatizada prepara su propio nodo, indexador y base temporal:

```sh
pnpm check:cli:regtest
```

Requiere Node 24, las dependencias instaladas, Docker en ejecución, `curl` y Python 3 en
macOS/Linux para los prompts en pseudoterminal. Usa fondos
regtest, mina bloques y ejecuta el launcher real del CLI. Verifica las
transacciones contra Bitcoin Core y elimina los recursos de su propia ejecución.
Las pruebas BTC/XBT simuladas siguen disponibles mediante `pnpm check:cli`.

Los resultados y transcripciones se guardan en un directorio temporal del sistema (su ruta se imprime al terminar); se puede cambiar
la ubicación con `REGTEST_EVIDENCE_DIR`. El nodo de pruebas permite scripts
OP_RETURN de hasta 1000 bytes para probar la protección BTC de 84 bytes.
La prueba de reorganización reconstruye el índice local después de invalidar
un bloque: la imagen fijada de Electrs falla al retroceder la cadena. El CLI
conserva su SQLite durante esa reconstrucción y debe actualizar confirmaciones
y balances al volver a sincronizar.

## Verificación

```sh
pnpm check
pnpm check:cli
pnpm lint
pnpm exec next typegen
pnpm exec tsc --noEmit
pnpm build
```

`check:cli` usa bases aisladas y servidores TCP/HTTP simulados. Verifica seeds,
descriptores, cursores, sincronización fresca, failover, cierre, comandos reales
desde otro directorio y firma/publicación BTC/XBT. No publica transacciones en
redes reales ni envía fondos.
