import { createHash } from 'node:crypto';

import { fieldInventorySchema, type FieldInventory } from '@job-agent/browser-core';
import type { Page } from 'playwright';

type RawControl = {
  fieldKey: string;
  label: string;
  controlType: string;
  selector: string;
  required: boolean;
  options: string[];
  maxLength: number | null;
};

type RawInventory = {
  stepId: string;
  controls: RawControl[];
  validationMessages: string[];
  humanOnlyMarkers: string[];
};

/**
 * Reads the shape of the form only: control names, labels, types, required flags and offered
 * options. Values the user or the agent has typed are deliberately not read back, so nothing
 * applicant-identifying leaves the page through the inventory.
 */
export async function inspectPage(page: Page): Promise<FieldInventory> {
  const raw: RawInventory = await page.evaluate(() => {
    const textOf = (element: Element | null): string =>
      (element?.textContent ?? '').replace(/\s+/g, ' ').trim();

    const labelFor = (element: HTMLElement): string => {
      // A radio group is named by its fieldset legend, not by whichever option happens to be first.
      if (element.getAttribute('type') === 'radio') {
        const fieldset = element.closest('fieldset');
        const legend = textOf(fieldset?.querySelector('legend') ?? null);
        if (legend !== '') return legend;
      }
      const id = element.getAttribute('id');
      if (id !== null && id !== '') {
        const explicit = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (explicit !== null) return textOf(explicit);
      }
      const wrapping = element.closest('label');
      if (wrapping !== null) return textOf(wrapping);
      const fieldset = element.closest('fieldset');
      if (fieldset !== null) return textOf(fieldset.querySelector('legend'));
      return element.getAttribute('aria-label') ?? element.getAttribute('name') ?? '';
    };

    const controls: RawControl[] = [];
    const seen = new Set<string>();
    const elements = Array.from(
      document.querySelectorAll<HTMLElement>('input, textarea, select'),
    ).filter((element) => {
      const type = element.getAttribute('type');
      if (type === 'submit' || type === 'button' || type === 'hidden') return false;
      // A control the page is not currently showing is not part of this step's inventory. A
      // conditional field only becomes answerable once the form reveals it.
      const visible =
        typeof element.checkVisibility === 'function'
          ? element.checkVisibility()
          : element.offsetParent !== null;
      return visible;
    });

    for (const element of elements) {
      const name = element.getAttribute('name');
      if (name === null || name === '' || name.startsWith('__')) continue;
      if (seen.has(name)) continue;
      seen.add(name);

      const tag = element.tagName.toLowerCase();
      const inputType = (element.getAttribute('type') ?? 'text').toLowerCase();
      const controlType =
        tag === 'textarea'
          ? 'textarea'
          : tag === 'select'
            ? 'select'
            : inputType === 'radio'
              ? 'radio'
              : inputType === 'checkbox'
                ? 'checkbox'
                : inputType === 'file'
                  ? 'file'
                  : inputType === 'email'
                    ? 'email'
                    : inputType === 'tel'
                      ? 'tel'
                      : inputType === 'number'
                        ? 'number'
                        : 'text';

      let options: string[] = [];
      if (tag === 'select') {
        options = Array.from(element.querySelectorAll('option'))
          .map((option) => option.getAttribute('value') ?? '')
          .filter((value) => value !== '');
      } else if (inputType === 'radio') {
        options = Array.from(
          document.querySelectorAll<HTMLInputElement>(
            `input[type=radio][name="${CSS.escape(name)}"]`,
          ),
        ).map((radio) => radio.value);
      }

      const maxLengthAttribute = element.getAttribute('maxlength');
      const required =
        element.hasAttribute('required') ||
        Array.from(document.querySelectorAll<HTMLElement>(`[name="${CSS.escape(name)}"]`)).some(
          (sibling) => sibling.hasAttribute('required'),
        );

      controls.push({
        fieldKey: name,
        label: labelFor(element),
        controlType,
        selector: `[name="${name}"]`,
        required,
        options,
        maxLength:
          maxLengthAttribute === null ? null : Number.parseInt(maxLengthAttribute, 10) || null,
      });
    }

    const validationMessages = Array.from(document.querySelectorAll('.errors li')).map((item) =>
      textOf(item),
    );
    const bodyText = document.body.textContent.toLowerCase();
    const humanOnlyMarkers = [
      'captcha',
      'one-time code',
      'assessment',
      'declare',
      'consent',
    ].filter((marker) => bodyText.includes(marker));

    return {
      stepId: document.body.getAttribute('data-step') ?? 'unknown',
      controls,
      validationMessages,
      humanOnlyMarkers,
    };
  });

  const fields = raw.controls.map((control) => ({
    fieldKey: control.fieldKey,
    label: control.label,
    controlType: control.controlType as FieldInventory['fields'][number]['controlType'],
    selector: control.selector,
    required: control.required,
    options: control.options,
    ...(control.maxLength === null ? {} : { maxLength: control.maxLength }),
  }));

  return fieldInventorySchema.parse({
    stepId: raw.stepId,
    url: page.url(),
    pageFingerprint: fingerprintOf(raw),
    fields,
    validationMessages: raw.validationMessages,
    humanOnlyMarkers: raw.humanOnlyMarkers,
  });
}

/** The fingerprint covers the form's shape, so adding or removing a control changes it. */
function fingerprintOf(raw: RawInventory): string {
  const material = raw.controls
    .map(
      (control) =>
        `${control.fieldKey}|${control.controlType}|${String(control.required)}|${control.options.join(',')}`,
    )
    .sort((left, right) => left.localeCompare(right))
    .join('\u001f');
  return createHash('sha256').update(`${raw.stepId}\u001e${material}`).digest('hex');
}
