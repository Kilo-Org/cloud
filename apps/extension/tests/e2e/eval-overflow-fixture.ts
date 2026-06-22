import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

export const expectEvalToolBoxNoHorizontalOverflow = async (sidePanel: Page): Promise<void> => {
  const overflowState = await sidePanel.evaluate(() => {
    const codeLabel = [...document.querySelectorAll('p')].find(
      element => element.textContent === 'Code'
    );
    const toolBox = codeLabel?.closest('details');
    const codeBlock = codeLabel?.parentElement?.querySelector('pre');
    const resultBlock = [...document.querySelectorAll('p')]
      .find(element => element.textContent === 'Result' || element.textContent === 'Error')
      ?.parentElement?.querySelector('pre');

    if (!(toolBox instanceof HTMLElement)) {
      throw new Error('Eval tool box was not found.');
    }

    if (!(codeBlock instanceof HTMLElement)) {
      throw new Error('Eval code block was not found.');
    }

    if (!(resultBlock instanceof HTMLElement)) {
      throw new Error('Eval result block was not found.');
    }

    return {
      codeBlockClientWidth: codeBlock.clientWidth,
      codeBlockOverflowX: getComputedStyle(codeBlock).overflowX,
      codeBlockScrollWidth: codeBlock.scrollWidth,
      resultBlockClientWidth: resultBlock.clientWidth,
      resultBlockOverflowX: getComputedStyle(resultBlock).overflowX,
      resultBlockScrollWidth: resultBlock.scrollWidth,
      toolBoxClientWidth: toolBox.clientWidth,
      toolBoxScrollWidth: toolBox.scrollWidth,
    };
  });

  expect(overflowState.toolBoxScrollWidth).toBeLessThanOrEqual(overflowState.toolBoxClientWidth);
  expect(overflowState.codeBlockScrollWidth).toBeLessThanOrEqual(
    overflowState.codeBlockClientWidth
  );
  expect(overflowState.codeBlockOverflowX).toBe('hidden');
  expect(overflowState.resultBlockScrollWidth).toBeLessThanOrEqual(
    overflowState.resultBlockClientWidth
  );
  expect(overflowState.resultBlockOverflowX).toBe('hidden');
};
