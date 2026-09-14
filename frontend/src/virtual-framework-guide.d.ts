/** Provided by the `framework-guide` Vite plugin (frontend/vite-plugin-framework-guide.ts):
 *  the guide in docs/src/guide.<locale>.html, parsed and keyed by className. */
declare module 'virtual:framework-guide/*' {
  import type { GuideEntry } from '../vite-plugin-framework-guide'
  const guide: Record<string, GuideEntry>
  export default guide
}
