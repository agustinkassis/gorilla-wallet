# Imágenes para redes sociales

Cada release se anuncia con las mismas dos imágenes, generadas desde una plantilla para que todas se vean iguales.
La horizontal se genera y se adjunta sola al release: el workflow de Desktop la sube al borrador junto a los
instaladores.

| Formato | Tamaño | Dónde |
|---|---|---|
| `landscape` | 1200×675 | X, LinkedIn, Facebook, Nostr, el release de GitHub |
| `square` | 1080×1080 | Instagram, Telegram |

## Generarlas

Requiere Google Chrome (o Chromium) instalado y conexión a internet para las fuentes. Como las features se leen de la
plantilla al momento del tag, actualizalas **antes** de taggear el release.

```bash
pnpm social
```

Deja `social/gorilla-wallet-v<versión>-landscape.png` y `social/gorilla-wallet-v<versión>-square.png`. La versión sale
de `package.json`, así que se generan **después** de subir la versión del release (README → Releasing). La carpeta
`social/` no se commitea.

Si Chrome está en otro lugar: `CHROME=/ruta/a/chrome pnpm social`.

## Qué cambiar en cada release

Solo el contenido, nunca el diseño. Todo está al final de [`docs/social/template.html`](social/template.html):

- `TAGLINE`: la frase junto a la versión. Hoy: *Self-hosted Bitcoin wallet*.
- `FEATURES`: exactamente **6** features, cada una como `["parte en negrita", " resto"]`, de unos 40 caracteres en
  total para que entren en una línea en los dos formatos. Si el release trae algo nuevo e importante, reemplazá la
  feature menos relevante en lugar de agregar una séptima.

Antes de publicar, abrí las dos imágenes y revisá que:

1. La versión es la del release (`v0.2.0`, no la anterior).
2. Ninguna feature corta en dos líneas.
3. El texto está en inglés, como la app y el README.

## Diseño (no cambiar sin decidirlo para todos los releases)

- **Arte:** la portada del splash (`components/splash.webp`). En `landscape` se muestra el gorila sin el título, a la
  derecha; en `square`, la portada completa con su título arriba.
- **Colores:** rojo `#cc0404` (el fondo de la portada), negro `#120607` para el panel, texto `#f6f1ea`.
- **Tipografías:** Bricolage Grotesque (títulos y features, la misma `--font-display` de la app) y Geist Mono (versión
  y URL).
- **Logo:** `app/icon.svg`, solo en `landscape` (en `square` el título ya está en el arte).
- **Pie:** `github.com/agustinkassis/gorilla-wallet`.

Si cambia la portada del splash o el logo, las imágenes se actualizan solas en el próximo `pnpm social`. Para
reencuadrar el gorila en `landscape`, ajustá `background-position` de `.art` en la plantilla.

## Publicarlas

1. La `landscape` ya está en los assets del release (`gorilla-wallet-v<versión>-landscape.png`). Revisala en el
   borrador antes de publicarlo. Si cambiaste las features después del tag, corré `pnpm social` y reemplazala
   (`gh release upload v<versión> social/gorilla-wallet-v<versión>-landscape.png --clobber`).
2. La `square` se genera local con `pnpm social`, para Instagram.
3. En redes, acompañalas con el link al release:
   `https://github.com/agustinkassis/gorilla-wallet/releases/tag/v<versión>`.
