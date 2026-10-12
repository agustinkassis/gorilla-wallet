# CLI local `gorilla`

La CLI funciona con Node 24 y las dependencias del checkout, sin iniciar Next.js.
Comparte wallets, seeds, labels, fuentes y SQLite con la web. No usa BDK ni RPC.

## Instalación

Desde el checkout de `gorilla-wallet`:

```sh
nvm use
corepack enable
pnpm install
pnpm link --global
gorilla --help
```

Si pnpm todavía no tiene directorio global, ejecutar `pnpm setup` y abrir una
terminal nueva. También se puede ejecutar `node bin/gorilla.mjs` desde el checkout.
El enlace necesita conservar el checkout y sus dependencias. No publica el paquete.

El launcher encuentra el proyecto mediante su propia ruta, carga los archivos
`.env` con el mismo cargador de Next.js y aplica las migraciones aditivas antes de
ejecutar comandos. No inicia el servidor web. Las rutas relativas de SQLite se
resuelven desde el proyecto; los archivos de secretos se resuelven desde el
directorio donde se invocó `gorilla`.

`DATABASE_URL` conserva su prioridad sobre `.env`. Para compartir una base del
desktop o de otro checkout, indicar la misma ruta absoluta, por ejemplo
`DATABASE_URL=file:/ruta/wallet.db gorilla wallet list`.

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
gorilla wallet list
gorilla wallet create --name ahorro                 # 24 palabras por defecto
gorilla wallet create --name gastos --words 12
gorilla wallet import --name recuperada             # prompt oculto para las palabras
gorilla wallet import --name recuperada --seed-file ./seed.txt
gorilla wallet export-seed --wallet ahorro
gorilla wallet export-seed --wallet ahorro --include-passphrase
gorilla wallet descriptor --wallet ahorro
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
gorilla receive --wallet ahorro --label "factura 123"
gorilla receive --wallet ahorro
gorilla receive --wallet ahorro --next
gorilla addresses --wallet ahorro
gorilla address label bc1q... "cliente" --wallet ahorro
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
gorilla balance --wallet ahorro --chain all
gorilla balance --chain btc --all-wallets --json
gorilla transactions --wallet ahorro --chain xbt
gorilla tx-status TXID --wallet ahorro --chain btc
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
gorilla config show
gorilla config set --chain btc \
  --electrum ssl://electrum.example.org:50002 \
  --electrum tcp://fulcrum.example.org:50001 \
  --mempool https://mempool.example.org
gorilla config set --chain xbt \
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
gorilla send --wallet ahorro --chain btc --to bc1q... --amount-sats 15000 \
  --message "factura 123" --fee-rate 2
gorilla send --wallet ahorro --chain xbt --to bc1q... --amount-sats 15000 \
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

## Bitcoin regtest

Regtest permite probar recepción, firma y publicación contra un nodo Bitcoin
local. Los comandos usan la misma implementación que BTC, con direcciones
`bcrt1`, firma SIGHASH_ALL y OP_RETURN de al menos 84 bytes en los envíos.
Los cursores y datos de red están separados de mainnet y testnet.

Configurá un servidor Electrum y una API compatible con mempool para tu nodo:

```sh
export DATABASE_URL=file:./data/regtest.db
gorilla config set --chain regtest \
  --electrum tcp://127.0.0.1:50001 \
  --mempool http://127.0.0.1:3000
gorilla wallet create --name prueba
gorilla receive --wallet prueba --chain regtest
gorilla wallet descriptor --wallet prueba --chain regtest
gorilla balance --wallet prueba --chain regtest
gorilla transactions --wallet prueba --chain regtest
```

También se pueden indicar las fuentes mediante `REGTEST_ELECTRUM` y
`MEMPOOL_REGTEST_URL`; la configuración guardada tiene prioridad. El puerto HTTP
debe ofrecer los endpoints `/api/...` usados por mempool; Esplora sin ese prefijo
necesita un proxy que lo adapte.

Tras financiar y confirmar la dirección desde tu nodo:

```sh
gorilla send --wallet prueba --chain regtest --to bcrt1... \
  --amount-sats 10000 --fee-rate 2 --message "prueba local"
gorilla tx-status TXID --wallet prueba --chain regtest
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
