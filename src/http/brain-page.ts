import { page } from './ui/layout.ts';

/** Placeholder for the Brain page; its content follows in E7-7a. */
export const BRAIN_HTML = page({
  title: 'Brain · Symphony',
  nav: 'brain',
  body: `
  <section aria-labelledby="page-title">
    <h1 id="page-title">Brain</h1>
    <p class="empty">Diese Seite kommt in Kürze.</p>
  </section>`,
  scripts: '',
});
