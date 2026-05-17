export class EventBus {
    listeners = new Map();
    wildcard = new Set();
    on(event, handler) {
        const set = this.listeners.get(event) ?? new Set();
        set.add(handler);
        this.listeners.set(event, set);
        return () => this.off(event, handler);
    }
    once(event, handler) {
        const off = this.on(event, (payload) => {
            off();
            handler(payload);
        });
        return off;
    }
    onAny(handler) {
        this.wildcard.add(handler);
        return () => this.wildcard.delete(handler);
    }
    off(event, handler) {
        this.listeners.get(event)?.delete(handler);
    }
    emit(event, payload) {
        for (const handler of this.listeners.get(event) ?? [])
            handler(payload);
        for (const handler of this.wildcard)
            handler(event, payload);
    }
    removeAll() {
        this.listeners.clear();
        this.wildcard.clear();
    }
}
//# sourceMappingURL=events.js.map