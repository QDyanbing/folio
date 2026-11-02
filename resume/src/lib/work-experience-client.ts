import { formatWorkExperience } from './work-experience.mjs';

export function setupWorkExperience() {
  const fields = [...document.querySelectorAll<HTMLElement>('[data-work-start]')];
  if (!fields.length) return;

  const refresh = () => {
    fields.forEach((field) => { field.textContent = formatWorkExperience(field.dataset.workStart); });
  };
  refresh();
  window.addEventListener('pageshow', refresh);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });
  document.addEventListener('resume:before-export', refresh);
  // Also update a page that stays open across the anniversary month.
  window.setInterval(refresh, 60_000);
}
