import { AURORA, page } from './ui/layout.ts';

/** Placeholder for the Tasks page; its content follows in E5-1. */
export const TASKS_HTML = page({
  title: 'Tasks · Symphony',
  nav: 'tasks',
  aurora: AURORA.tasks,
  body: `
  <section aria-labelledby="page-title">
    <h1 id="page-title">Tasks</h1>
    <p class="empty">Diese Seite kommt in Kürze.</p>
  </section>`,
  scripts: '',
});
