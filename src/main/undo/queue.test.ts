import { beforeEach, describe, expect, it, vi } from 'vitest';
import { undoQueue, __test, type UndoEntry } from './queue';

const { MAX_ENTRIES } = __test;

function entry(libraryId: string, label: string): UndoEntry {
  return {
    libraryId,
    label,
    undo: async () => ({ ok: true })
  };
}

beforeEach(() => {
  undoQueue.reset();
});

describe('undoQueue', () => {
  it('starts empty', () => {
    expect(undoQueue.size()).toBe(0);
    expect(undoQueue.peek()).toBeNull();
    expect(undoQueue.pop()).toBeNull();
  });

  it('pushes and pops LIFO', () => {
    undoQueue.push(entry('lib-1', 'a'));
    undoQueue.push(entry('lib-1', 'b'));
    undoQueue.push(entry('lib-1', 'c'));
    expect(undoQueue.size()).toBe(3);
    expect(undoQueue.peek()?.label).toBe('c');
    expect(undoQueue.pop()?.label).toBe('c');
    expect(undoQueue.pop()?.label).toBe('b');
    expect(undoQueue.pop()?.label).toBe('a');
    expect(undoQueue.pop()).toBeNull();
  });

  it('caps at MAX_ENTRIES by dropping oldest', () => {
    for (let i = 0; i < MAX_ENTRIES + 5; i++) {
      undoQueue.push(entry('lib-1', `op-${i}`));
    }
    expect(undoQueue.size()).toBe(MAX_ENTRIES);
    // The first 5 should have been dropped.
    expect(undoQueue.peek()?.label).toBe(`op-${MAX_ENTRIES + 4}`);
  });

  it('clear() drops only entries for the given library', () => {
    undoQueue.push(entry('lib-1', 'a'));
    undoQueue.push(entry('lib-2', 'b'));
    undoQueue.push(entry('lib-1', 'c'));
    undoQueue.clear('lib-1');
    expect(undoQueue.size()).toBe(1);
    expect(undoQueue.peek()?.libraryId).toBe('lib-2');
  });

  it('notifies subscribers on push, pop, and clear', () => {
    const fn = vi.fn();
    const unsubscribe = undoQueue.subscribe(fn);

    undoQueue.push(entry('lib-1', 'a'));
    expect(fn).toHaveBeenCalledTimes(1);
    undoQueue.pop();
    expect(fn).toHaveBeenCalledTimes(2);
    undoQueue.push(entry('lib-1', 'b'));
    undoQueue.clear('lib-1');
    expect(fn).toHaveBeenCalledTimes(4);

    unsubscribe();
    undoQueue.push(entry('lib-1', 'c'));
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('does not notify when clear() removes nothing', () => {
    undoQueue.push(entry('lib-1', 'a'));
    const fn = vi.fn();
    undoQueue.subscribe(fn);
    undoQueue.clear('lib-other');
    expect(fn).not.toHaveBeenCalled();
  });

  it('listener errors do not break the queue', () => {
    undoQueue.subscribe(() => {
      throw new Error('boom');
    });
    expect(() => undoQueue.push(entry('lib-1', 'a'))).not.toThrow();
    expect(undoQueue.size()).toBe(1);
  });
});
