import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('Projects collapse removes descendants and restores nested collapse state', () => {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.attributes = {}; }
    appendChild(node) { this.children.push(node); return node; }
    replaceChildren(...nodes) { this.children = nodes; }
    set innerHTML(value) { if (!value) this.children = []; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener() {}
  }
  const list = new Element('ul');
  const elements = { projectTaskListContainer: list };
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const tasks = [
    { id: 'parent', title: 'Parent', status: 'active' },
    { id: 'child', title: 'Child', parent_id: 'parent', status: 'active' },
    { id: 'grandchild', title: 'Grandchild', parent_id: 'child', status: 'active' },
    { id: 'sibling', title: 'Sibling', status: 'active' }
  ];
  const app = { getGlobalProjects: () => [{ id: 'inbox', name: 'Inbox', icon: '', color: '' }], getTasks: () => tasks, sortTasks: list => list, loadStorage() {} };
  const window = { location: { search: '' }, addEventListener() {}, TaskitatorApp: app };
  const document = { getElementById: id => elements[id] || null, createElement: tag => new Element(tag) };
  vm.runInNewContext(fs.readFileSync(new URL('./views/projects.js', import.meta.url), 'utf8'), { window, document, localStorage: storage, TaskitatorApp: app, TaskitatorRecurrence: { today: () => '2026-11-14' } });
  const click = el => el.onclick({ stopPropagation() {} });
  const rowToggle = node => node.children[0].children[0].children[0];
  window.refreshCurrentProjectView();
  assert.equal(list.children.length, 2);
  let parent = list.children[0];
  assert.equal(parent.children[1].children[0].children[1].children.length, 1, 'grandchild is initially rendered');
  click(rowToggle(parent.children[1].children[0]));
  parent = list.children[0];
  assert.equal(parent.children[1].children[0].children.length, 1, 'collapsing a child removes its subtree');
  click(rowToggle(parent));
  parent = list.children[0];
  assert.equal(parent.children.length, 1, 'collapsed parent has no subtree occupying space');
  assert.equal(list.children.length, 2, 'sibling remains visible');
  click(rowToggle(parent));
  parent = list.children[0];
  assert.equal(parent.children[1].children[0].children.length, 1, 'nested collapse remains after reopening parent');
  click(rowToggle(parent.children[1].children[0]));
  assert.equal(list.children[0].children[1].children[0].children[1].children.length, 1, 'grandchild returns when expanded');
});
