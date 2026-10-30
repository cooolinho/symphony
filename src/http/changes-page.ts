import { page } from './ui/layout.ts';

/** Placeholder for the Changes page; its content follows in E6-3a. */
export const CHANGES_HTML = page({
  title: 'Changes · Symphony',
  nav: 'changes',
  body: `
  <section aria-labelledby="page-title">
    <h1 id="page-title">Changes</h1>
    <p class="empty">Diese Seite kommt in Kürze.</p>
  </section>`,
  scripts: '',
});
