import { describe, expect, it } from 'vitest';
import { createImportOperationLock } from '../client/import-operation';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('import request ownership', () => {
  it('locks synchronously while a saved receipt loads, before UI state renders', async () => {
    const busy: boolean[] = [];
    const lock = createImportOperationLock(value => busy.push(value));
    const response = deferred<string>();
    let draft = 'accepted preview A';
    const opening = lock.begin(() => { draft = 'accepted preview A'; })!;
    const load = response.promise.then(receipt => {
      if (lock.current(opening)) draft = receipt;
    }).finally(() => lock.finish(opening));
    expect(busy).toEqual([true]);
    expect(lock.begin()).toBeNull(); // An import commit cannot acquire ownership.
    response.resolve('saved receipt B');
    await load;
    expect(draft).toBe('saved receipt B');
    expect(busy).toEqual([true, false]);
  });

  it('ignores an old receipt after unmount and cannot release a newer request lock', async () => {
    let draft = 'accepted preview A';
    const busy: boolean[] = [];
    const lock = createImportOperationLock(value => busy.push(value));
    const response = deferred<string>();
    const old = lock.begin(() => { draft = 'accepted preview A'; })!;
    const load = response.promise.then(receipt => {
      if (lock.current(old)) draft = receipt;
    }).finally(() => lock.finish(old));
    lock.cancelRead();
    const current = lock.begin()!;
    draft = 'uncertain import A';
    response.resolve('unfinished receipt B');
    await load;
    expect(draft).toBe('uncertain import A');
    expect(lock.current(current)).toBe(true);
    expect(busy).toEqual([true, false, true]);
    lock.finish(current);
    expect(busy.at(-1)).toBe(false);
  });

  it('keeps an in-flight commit owned across reauthentication', () => {
    const lock = createImportOperationLock(() => {});
    const commit = lock.begin()!;
    lock.cancelRead();
    expect(lock.current(commit)).toBe(true);
    expect(lock.begin(() => {})).toBeNull();
    lock.finish(commit);
    expect(lock.busy).toBe(false);
  });

  it('restores the prior draft and releases navigation when an unfinished read is abandoned', () => {
    let draft = 'accepted preview A';
    let navigationLocked = false;
    const lock = createImportOperationLock(value => { navigationLocked = value; });
    const read = lock.begin(() => { draft = 'accepted preview A'; })!;
    draft = 'previewing';
    lock.cancelRead();
    expect(draft).toBe('accepted preview A');
    expect(navigationLocked).toBe(false);
    expect(lock.current(read)).toBe(false);
    lock.finish(read);
    expect(navigationLocked).toBe(false);
  });
});
