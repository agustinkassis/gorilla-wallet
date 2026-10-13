// Renders the release's social images from docs/social/template.html with headless Chrome (see docs/SOCIAL.md).
// Usage: pnpm social   → social/gorilla-wallet-v<version>-{landscape,square}.png
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const SIZES = { landscape: [1200, 675], square: [1080, 1080] }

const chrome = [
  process.env.CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].find((p) => p && existsSync(p))
if (!chrome) {
  console.error("Chrome not found: install Google Chrome or set CHROME=/path/to/chrome")
  process.exit(1)
}

const { version } = JSON.parse(readFileSync("package.json", "utf8"))
const url = `${pathToFileURL(resolve("docs/social/template.html"))}?v=${version}`
mkdirSync("social", { recursive: true })

for (const [name, [width, height]] of Object.entries(SIZES)) {
  const out = resolve(`social/gorilla-wallet-v${version}-${name}.png`)
  execFileSync(chrome, [
    "--headless",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--window-size=${width},${height}`,
    "--virtual-time-budget=10000", // lets the Google Fonts load before the shot
    `--screenshot=${out}`,
    url,
  ], { stdio: "ignore" })
  console.log(out)
}
