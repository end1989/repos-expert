import { describe, it, expect } from 'vitest';
import {
  estimateBatch,
  formatDryRun,
  formatEstimate,
  needsConfirmation,
} from '../src/cli/estimate.js';

describe('estimateBatch', () => {
  it('divides wall-clock by concurrency but never the cost', () => {
    const one = estimateBatch(8, 1);
    const four = estimateBatch(8, 4);
    expect(four.minutesLow).toBeLessThan(one.minutesLow);
    expect(four.dollars).toBe(one.dollars);
  });

  it('never promises less time than a single repo takes', () => {
    const est = estimateBatch(2, 16);
    expect(est.minutesLow).toBeGreaterThanOrEqual(estimateBatch(1, 1).minutesLow);
  });

  it('scales cost with the number of repos', () => {
    expect(estimateBatch(10, 2).dollars).toBeCloseTo(estimateBatch(5, 2).dollars * 2, 5);
  });
});

describe('formatEstimate', () => {
  it('gives a range, and is explicit that a subscription is not billed per repo', () => {
    const out = formatEstimate(estimateBatch(20, 2), 20);
    expect(out).toMatch(/20 repos/);
    expect(out).toMatch(/–|-/); // a range, not false precision
    expect(out).toMatch(/subscription/i);
    expect(out).toMatch(/estimate/i);
  });
});

describe('formatDryRun', () => {
  it('lists what would be studied and states that nothing was spent', () => {
    const out = formatDryRun(['alpha', 'beta'], estimateBatch(2, 2));
    expect(out).toContain('alpha');
    expect(out).toContain('beta');
    expect(out).toMatch(/nothing (was )?(spent|studied)/i);
  });

  it('does not print a hundred names, but says how many it hid', () => {
    const names = Array.from({ length: 60 }, (_, i) => `repo-${i}`);
    const out = formatDryRun(names, estimateBatch(60, 4));
    expect(out).toContain('repo-0');
    expect(out).not.toContain('repo-59');
    expect(out).toMatch(/40 more/);
  });
});

describe('needsConfirmation', () => {
  it('does not interrupt a small batch', () => {
    expect(needsConfirmation(3, true)).toBe(false);
  });

  it('asks before a big one', () => {
    expect(needsConfirmation(40, true)).toBe(true);
  });

  it('never asks when nobody is there to answer', () => {
    expect(needsConfirmation(40, false)).toBe(false);
  });
});
