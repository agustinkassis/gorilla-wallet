import type { Metadata } from "next"
import "../globals.css"

export const metadata: Metadata = { title: "Gorilla Wallet module", robots: { index: false } }

// System fonts: an opaque-origin document can't load the app's web fonts (fonts need CORS)
const fonts = { "--font-sans": "ui-sans-serif, system-ui, sans-serif", "--font-geist-mono": "ui-monospace, monospace", "--font-display": "ui-sans-serif, system-ui, sans-serif" }

/**
 * Root layout of module frames: styles only, none of the wallet's providers, state or API. next.config.ts serves
 * every /m/* page with a CSP sandbox (opaque origin) and no network, so module code can only talk to its host frame.
 */
export default function ModuleLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="antialiased" style={fonts as React.CSSProperties} suppressHydrationWarning>
      <head>
        {/* Next's bootstrap reads document.cookie, which throws in an opaque-origin document */}
        <script dangerouslySetInnerHTML={{ __html: `Object.defineProperty(Document.prototype,"cookie",{get:()=>"",set:()=>{}})` }} />
      </head>
      <body className="bg-transparent! before:hidden after:hidden">{children}</body>
    </html>
  )
}
