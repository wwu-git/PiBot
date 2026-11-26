import type { Page } from "../dev/cdp/page.ts";
import { until } from "./util.mts";

/** DOM operations only: visible controls, native setters and clicks, no application internals. */
export class Ui {
  readonly page: Page;
  readonly signal: AbortSignal;
  constructor(page: Page, signal: AbortSignal) {
    this.page = page;
    this.signal = signal;
  }
  private async ready(name: string, expression: string) {
    return until(name, () => this.page.eval<boolean>(expression), Boolean, this.signal, 15000);
  }
  async click(key: string) {
    const texts = this.page.texts(key);
    await this.ready(
      `click:${key}`,
      `(() => {
      const texts = ${JSON.stringify(texts)};
      const button = [...document.querySelectorAll('button')].find(e =>
        e.getClientRects().length && !e.matches(':disabled') &&
        texts.includes(e.innerText.trim()));
      if (!button) return false;
      button.scrollIntoView({block:'center'});
      button.click(); return true;
    })()`,
    );
    await this.page.settle();
  }
  async combo(key: string, option: string) {
    const labels = this.page.texts(key);
    const found = await this.ready(
      `combo:${key}`,
      `(() => {
      const labels=${JSON.stringify(labels)};
      const label=[...document.querySelectorAll('label')].find(e=>e.getClientRects().length && labels.includes(e.textContent.trim()));
      const button=label && document.getElementById(label.htmlFor);
      if (!(button instanceof HTMLButtonElement) || button.matches(':disabled')) return false;
      button.scrollIntoView({block:'center'}); button.click(); return true;
    })()`,
    );
    if (!found) throw new Error(`e2e_combo_unavailable:${key}`);
    const texts = this.page.texts(option);
    await until(
      `option:${option}`,
      () =>
        this.page.eval<boolean>(`(() => {
      const texts=${JSON.stringify(texts)};
      const choices=[...document.querySelectorAll('[role=option]')].filter(e=>e.getClientRects().length && e.getAttribute('aria-disabled')!=='true');
      const exact=choices.find(e=>texts.includes(e.innerText.trim()));
      const matches=choices.filter(e=>texts.some(t=>e.innerText.includes(t)));
      const found=exact || (matches.length===1 ? matches[0] : null);
      if (!found) return false; found.click(); return true;
    })()`),
      Boolean,
      this.signal,
    );
    await this.page.settle();
  }
  async check(key: string, checked: boolean, vars?: Record<string, string>) {
    const labels = this.page.texts(key, vars);
    const ok = await this.ready(
      `check:${key}`,
      `(() => {
      const texts=${JSON.stringify(labels)};
      const inputs=[...document.querySelectorAll('input[type=checkbox],input[type=radio],[role=switch]')].filter(e=>e.getClientRects().length);
      const el=inputs.find(e=>texts.includes(e.getAttribute('aria-label')) || texts.includes(e.closest('label')?.textContent.trim()));
      if (!el || el.matches(':disabled')) return false;
      if ((el instanceof HTMLInputElement ? el.checked : el.getAttribute('aria-checked')==='true') !== ${checked}) el.click();
      return true;
    })()`,
    );
    if (!ok) throw new Error(`e2e_check_unavailable:${key}`);
    await this.page.settle();
  }
  async segment(category: string, value: string) {
    const labels = this.page.texts(category),
      options = this.page.texts(value);
    const ok = await this.ready(
      `permission:${category}`,
      `(() => {
      const groups=[...document.querySelectorAll('fieldset')];
      // A group is named by its legend or, for card choices, by aria-label; a card option by its title.
      const group=groups.find(e=>${JSON.stringify(labels)}.includes(e.querySelector('legend')?.textContent.trim() ?? '') || ${JSON.stringify(labels)}.includes(e.getAttribute('aria-label')?.trim() ?? ''));
      const label=group && [...group.querySelectorAll('label')].find(e=>${JSON.stringify(options)}.includes(e.textContent.trim()) || ${JSON.stringify(options)}.includes(e.querySelector('strong')?.firstChild?.textContent?.trim() ?? ''));
      const button=label?.querySelector('input');
      if (!button || button.matches(':disabled')) return false; button.click(); return true;
    })()`,
    );
    if (!ok) throw new Error(`e2e_permission_unavailable:${category}`);
    await this.page.settle();
  }
  async chatText(text: string) {
    const ok = await this.ready(
      "chat_input",
      `(() => {
      const input=[...document.querySelectorAll('textarea')].find(e=>e.getClientRects().length && !e.matches(':disabled'));
      if (!input) return false;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(text)});
      input.dispatchEvent(new Event('input',{bubbles:true})); return true;
    })()`,
    );
    if (!ok) throw new Error("e2e_chat_input_unavailable");
    await this.page.settle();
  }
}
