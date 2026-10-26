export type CancelDelay = () => void;
export type DelayScheduler = (callback: () => void, delayMs: number) => CancelDelay;

/** A component-owned timer for Lens runtimes predating native setTimeout. */
export function createLensScheduler(host: {
    createEvent(name: 'DelayedCallbackEvent'): { bind(callback: () => void): void; reset(seconds: number): void; enabled: boolean };
    removeEvent(event: any): void;
}): DelayScheduler {
    return (callback, delayMs) => {
        const event = host.createEvent('DelayedCallbackEvent');
        let active = true;
        const cancel = () => {
            if (!active) return;
            active = false;
            event.enabled = false;
            host.removeEvent(event);
        };
        event.bind(() => { if (active) { cancel(); callback(); } });
        event.reset(Math.max(0, delayMs) / 1000);
        return cancel;
    };
}

export const scheduleDelay: DelayScheduler = (callback, delayMs) => {
    // @ts-ignore Native timers are absent from older Lens declaration files.
    if (typeof setTimeout === 'function') {
        // @ts-ignore See above.
        const id = setTimeout(callback, delayMs);
        // @ts-ignore See above.
        return () => clearTimeout(id);
    }
    // A plain HTTP client need not have a user-supplied ScriptComponent. Give
    // this timer a scene-owned host and remove it after firing or cancellation.
    // @ts-ignore Lens global, intentionally absent from Node's declarations.
    if (typeof global !== 'undefined' && global.scene) {
        // @ts-ignore Lens global.
        const object = global.scene.createSceneObject('Estuary HTTP timer');
        const host = object.createComponent('Component.ScriptComponent');
        let destroyed = false;
        const destroy = () => { if (!destroyed) { destroyed = true; object.destroy(); } };
        try {
            const cancel = createLensScheduler(host)(() => { destroy(); callback(); }, delayMs);
            return () => { if (!destroyed) { cancel(); destroy(); } };
        } catch (error) { destroy(); throw error; }
    }
    throw new Error('No Lens timer host available. Pass createLensScheduler(script) to EstuaryHttpClient.');
};
