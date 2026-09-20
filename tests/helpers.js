import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';

export async function waitFor(condition, label) {
  const deadline = Date.now() + 1000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
    await setTimeout(5);
  }
}
