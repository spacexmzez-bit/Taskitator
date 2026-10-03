// Shared rendering and task-tree checks. Never interpret user labels as markup.
window.TaskitatorSafety = {
    escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, char => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[char]);
    },

    setProjectLabel(element, project) {
        const icon = document.createElement('span');
        const name = document.createElement('span');
        icon.textContent = project.icon || '';
        name.textContent = project.name || '';
        element.replaceChildren(icon, document.createTextNode(' '), name);
    },

    collectSubtree(tasks, rootId) {
        const ids = new Set();
        const pending = [rootId];
        while (pending.length) {
            const id = pending.pop();
            if (ids.has(id)) continue;
            ids.add(id);
            tasks.filter(task => task.parent_id === id).forEach(task => pending.push(task.id));
        }
        return tasks.filter(task => ids.has(task.id));
    },

    deletionError(tasks, rootId, bypassActive = false) {
        if (bypassActive) return null;
        const subtree = this.collectSubtree(tasks, rootId);
        if (subtree.some(task => task.ai_locked)) {
            return 'This task or one of its subtasks is AI-locked. An active Emergency Bypass is required to delete it.';
        }
        if (subtree.some(task => task.strict_prerequisites &&
            this.collectSubtree(tasks, task.id).some(child => child.id !== task.id &&
                child.status !== 'completed' && child.status !== 'trash'))) {
            return 'Shielded tasks with pending subtasks cannot be deleted without an active Emergency Bypass.';
        }
        return null;
    }
};
