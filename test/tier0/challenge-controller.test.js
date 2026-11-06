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
    expect(progressBarEl.style.width).toBe('0%');
    wordInputEl.value = 'alpha';
    expect(c.handleConfirm().status).toBe('advanced');
    expect(progressBarEl.style.width).toBe('50%');
    wordInputEl.value = 'beta';
    expect(c.handleConfirm().status).toBe('ok');
    expect(progressBarEl.style.width).toBe('100%');
});
