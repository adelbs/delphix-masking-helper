/** Provided by the `algo-guide` Vite plugin (frontend/vite-plugin-algo-guide.ts):
 *  the guide in docs/src/guide.<locale>.html, parsed and keyed by className. */
declare module 'virtual:algo-guide/*' {
  import type { GuideEntry } from '../vite-plugin-algo-guide'
  const guide: Record<string, GuideEntry>
  export default guide
}
