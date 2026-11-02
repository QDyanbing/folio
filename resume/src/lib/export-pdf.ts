import printCss from '../styles/print.css?raw';

// Reuse the native print layout without changing the visible page or its state.
function exportStyles() {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(printCss);
  return [...sheet.cssRules].flatMap((rule) => rule instanceof CSSMediaRule ? [...rule.cssRules] : [])
    .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
    .map((rule) => {
      const selectors = rule.selectorText.split(',').map((selector) => {
        const value = selector.trim();
        return [':root', 'html', 'body'].includes(value) ? '.pdf-export' : `.pdf-export ${value}`;
      });
      return `${selectors.join(',')} { ${rule.style.cssText} }`;
    }).join('\n');
}

async function preparePage() {
  const pending: Promise<unknown>[] = [];
  // Future dynamic components can finish data loading before the DOM is captured.
  document.dispatchEvent(new CustomEvent('resume:before-export', {
    detail: { waitUntil: (promise: Promise<unknown>) => pending.push(Promise.resolve(promise)) },
  }));
  await Promise.all(pending);
  await document.fonts.ready;
}

function snapshotPage() {
  const source = document.querySelector<HTMLElement>('.page-shell');
  if (!source) throw new Error('简历正文不存在。');
  const snapshot = source.cloneNode(true) as HTMLElement;
  // cloneNode does not preserve canvas pixels or current form control values.
  source.querySelectorAll('canvas').forEach((canvas, index) => {
    const target = snapshot.querySelectorAll('canvas')[index];
    target.width = canvas.width;
    target.height = canvas.height;
    target.getContext('2d')?.drawImage(canvas, 0, 0);
  });
  source.querySelectorAll('input, textarea, select').forEach((control, index) => {
    const target = snapshot.querySelectorAll('input, textarea, select')[index];
    if (control instanceof HTMLInputElement && target instanceof HTMLInputElement) {
      target.value = control.value;
      target.checked = control.checked;
    } else if (control instanceof HTMLTextAreaElement && target instanceof HTMLTextAreaElement) {
      target.value = control.value;
      target.textContent = control.value;
    } else if (control instanceof HTMLSelectElement && target instanceof HTMLSelectElement) {
      [...target.options].forEach((option, optionIndex) => { option.selected = control.options[optionIndex].selected; });
    }
  });
  snapshot.querySelectorAll('[data-pdf-exclude], script, noscript').forEach((node) => node.remove());
  // html2pdf does not honor break-after: avoid. Keep a section title and its
  // first content block together so the title cannot be left at a page foot.
  snapshot.querySelectorAll('.section-heading').forEach((heading) => {
    const firstBlock = heading.nextElementSibling;
    const group = document.createElement('div');
    group.className = 'pdf-section-lead';
    heading.before(group);
    group.append(heading);
    if (firstBlock) group.append(firstBlock);
  });
  const root = document.createElement('div');
  root.className = 'pdf-export';
  root.append(snapshot);
  return root;
}

export function setupExport() {
  const actions = document.querySelector<HTMLElement>('#export-actions');
  const button = document.querySelector<HTMLButtonElement>('#download-resume');
  const printButton = document.querySelector<HTMLButtonElement>('#print-resume');
  const label = document.querySelector<HTMLElement>('#download-label');
  const status = document.querySelector<HTMLElement>('#export-status');
  if (!actions || !button || !printButton || !label || !status) return;
  actions.hidden = false;

  printButton.addEventListener('click', async () => {
    try { await preparePage(); window.print(); }
    catch { status.textContent = '内容还未准备好，请稍后重试。'; }
  });

  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    label.textContent = '正在生成…';
    status.textContent = '正在生成当前简历的 PDF，请稍候。';
    const style = document.createElement('style');
    try {
      const [{ default: html2pdf }] = await Promise.all([import('html2pdf.js'), preparePage()]);
      const root = snapshotPage();
      style.textContent = exportStyles();
      document.head.append(style);
      await html2pdf().set({
        filename: button.dataset.filename || 'resume.pdf',
        margin: [13, 15, 16, 15],
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: {
          scale: 2,
          useCORS: true,
          backgroundColor: '#ffffff',
          logging: false,
          windowWidth: 794,
          scrollY: 0,
          scrollX: 0,
          onclone: async (document: Document) => {
            await document.fonts.ready;
            await Promise.all([...document.images].map((image) => image.decode().catch(() => undefined)));
          },
        },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait', compress: true },
        pagebreak: { mode: ['css'], avoid: ['.pdf-section-lead', '.resume-entry', '.section-heading', '.entry-header', 'li', 'img', 'canvas'] },
      }).from(root).toPdf().get('pdf').then((pdf: any) => {
        const pages = pdf.internal.getNumberOfPages();
        pdf.setProperties({ title: document.title, subject: '个人简历', creator: location.hostname });
        pdf.setFontSize(8);
        pdf.setTextColor(104, 113, 103);
        for (let index = 1; index <= pages; index += 1) {
          pdf.setPage(index);
          pdf.text(`${index} / ${pages}`, 105, 289, { align: 'center' });
        }
      }).save();
      status.textContent = 'PDF 已生成，下载已开始。';
    } catch (error) {
      console.error('PDF export failed:', error);
      status.textContent = 'PDF 生成失败，请重试，或点击「打印」另存为 PDF。';
    } finally {
      style.remove();
      document.querySelectorAll('.html2pdf__overlay').forEach((overlay) => overlay.remove());
      button.disabled = false;
      button.removeAttribute('aria-busy');
      label.textContent = '下载 PDF';
    }
  });
}
