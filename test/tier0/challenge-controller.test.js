import { expect, test } from 'vitest';
import { createChallengeController } from '../../src/challenge-controller.js';

test('word mode: the progress bar starts empty and fills per finished word', () => {
    const el = () => document.createElement('div');
    const wordInputEl = document.createElement('input');
    const progressBarEl = el();
    const c = createChallengeController({
        // No textEl: its renderer measures text ranges, which jsdom does not implement.
        textEl: null, inputEl: document.createElement('textarea'), wordInputEl,
        wordProgressEl: el(), currentWordEl: el(), progressBarEl,
        confirmBtnEl: document.createElement('button'), modalContentEl: el(),
    });
    c.open({ text: 'alpha beta', wordMode: true });
    c.setConfirmLabel('Pause for 10 minutes');
    expect(progressBarEl.style.width).toBe('0%');
    wordInputEl.value = 'alpha';
    expect(c.handleConfirm().status).toBe('advanced');
    expect(progressBarEl.style.width).toBe('50%');
    // Changing duration must retain mobile word progress and the final label.
    c.setConfirmLabel('Pause for 5 minutes');
    wordInputEl.value = 'beta';
    expect(c.handleConfirm().status).toBe('ok');
    expect(progressBarEl.style.width).toBe('100%');
});

test('changing the confirmation label preserves desktop typed progress', () => {
    const inputEl = document.createElement('textarea');
    const confirmBtnEl = document.createElement('button');
    const c = createChallengeController({ inputEl, confirmBtnEl });
    c.open({ text: 'alpha beta', wordMode: false });
    inputEl.value = 'alpha beta';
    c.setConfirmLabel('Pause for 5 minutes');
    expect(inputEl.value).toBe('alpha beta');
    expect(confirmBtnEl.textContent).toBe('Pause for 5 minutes');
    expect(c.handleConfirm().status).toBe('ok');
});
