/** Re-mounted on every navigation (unlike the layout), so each page plays its entrance. */
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-1 flex-col gap-6 animate-page-in">{children}</div>
}
