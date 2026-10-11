import cover from "@/components/splash.webp"

/**
 * Desktop app boot screen. The window opens on the same screen served locally (src-tauri/splash) while the server
 * starts; here it covers the first page load, the bar filling as the page's scripts, styles and fonts arrive, then
 * fades out. Only in the desktop app (src-tauri sets __GORILLA_NATIVE__ before any script): the web never shows it.
 */
const CSS = `
#splash{display:none}
[data-boot] #splash{position:fixed;inset:0;z-index:2147483647;display:block;background:#cc0404;transition:opacity .35s ease,visibility .35s}
[data-boot=done] #splash{opacity:0;visibility:hidden;pointer-events:none}
#splash img{width:100%;height:100%;object-fit:cover;object-position:center top}
@media (max-aspect-ratio:1/1){#splash img{object-fit:contain;object-position:center}}
#splash .foot{position:absolute;left:50%;bottom:max(24px,5vh);display:flex;flex-direction:column;align-items:center;gap:10px;transform:translateX(-50%)}
#splash .track{width:min(320px,60vw);height:8px;border-radius:999px;background:rgba(0,0,0,.6);box-shadow:0 0 0 1px rgba(255,255,255,.35),0 2px 16px rgba(0,0,0,.5);overflow:hidden}
#splash .version{padding:4px 8px;border-radius:999px;background:rgba(0,0,0,.6);color:#fff;font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em}
#splash-bar{height:100%;border-radius:inherit;background:#fff;transform:scaleX(0);transform-origin:left;transition:transform .2s ease-out}
`

// Progress = page assets with a finished resource timing entry / page assets found so far (capped until the HTML is
// fully parsed, since more keep appearing). Done once everything has loaded; 20 s at most, never stuck on a slow asset.
const PROGRESS = `(function(){
var root=document.documentElement;if(!root.dataset.boot)return;
var img=document.querySelector("#splash img");img.src=img.dataset.src;
var bar=document.getElementById("splash-bar"),shown=0,start=Date.now();
function step(){
var urls={},total=0,loaded=0,seen={};
document.querySelectorAll("script[src]:not([nomodule]),link[rel=stylesheet][href],link[rel=preload][href]").forEach(function(e){urls[e.src||e.href]=1});
performance.getEntriesByType("resource").forEach(function(e){seen[e.name]=1});
for(var u in urls){total++;if(seen[u])loaded++}
var p=total?loaded/total:0;if(document.readyState==="loading")p=Math.min(p,.9);
shown=Math.max(shown,p);bar.style.transform="scaleX("+shown+")";
if((shown>=1&&document.readyState==="complete")||Date.now()-start>2e4)return setTimeout(function(){root.dataset.boot="done"},250);
requestAnimationFrame(step)}
step()})()`

/** In <head>: the styles, and the native flag turned into data-boot before anything paints. */
export function SplashHead() {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <script dangerouslySetInnerHTML={{ __html: `if(window.__GORILLA_NATIVE__)document.documentElement.dataset.boot="native"` }} />
    </>
  )
}

/** First thing in <body>, so it paints before the app. */
export function Splash() {
  return (
    <>
      <div id="splash" aria-hidden="true">
        {/* src set by PROGRESS only in the desktop app: the web never downloads it */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img data-src={cover.src} alt="" suppressHydrationWarning />
        <div className="foot">
          <div className="track">
            <div id="splash-bar" />
          </div>
          <span className="version">v{process.env.APP_VERSION}</span>
        </div>
      </div>
      <script dangerouslySetInnerHTML={{ __html: PROGRESS }} />
    </>
  )
}
